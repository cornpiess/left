import Photos
import UIKit
import Darwin
import Network

/// Bounded, main-thread diagnostics for the photo DISPLAY chain (P0 fix).
/// Records carry view identity + geometry state, never photo IDs or paths.
/// Events drain into the existing flight log via getPerformanceSnapshot.
final class PhotoDiagnostics {
  static let shared = PhotoDiagnostics()
  private var records: [String] = []
  private var nextViewIdValue = 0
  private var assignedImages: Double = 0
  private var droppedCallbacks: Double = 0
  private var clearedImages: Double = 0
  private var layoutAnomalies: Double = 0
  private let cap = 64

  func nextViewId() -> Int {
    nextViewIdValue += 1
    return nextViewIdValue
  }

  /// One bounded line: kind|view|purpose|generation|state fields|reason.
  func note(viewId: Int, purpose: String, view: UIView?, kind: String, generation: Int, reason: String) {
    let state: String
    if let view, let content = view as? MaoqiuPhotoPreviewView {
      let img = content.imageView
      let box = content.contentView.bounds.size
      let frame = img.bounds.size
      var mask = "0"
      if let shape = img.layer.mask as? CAShapeLayer {
        let b = shape.path?.boundingBoxOfPath ?? .zero
        mask = "i:B\(Int(b.width))x\(Int(b.height))"
      } else if img.layer.mask != nil { mask = "i:O" }
      state = "img\(img.image != nil ? 1 : 0)|c\(Int(box.width))x\(Int(box.height))|i\(Int(frame.width))x\(Int(frame.height))|w\(view.window != nil ? 1 : 0)|m\(mask)"
    } else {
      state = "img?"
    }
    if records.count >= cap { records.removeFirst(records.count - cap + 1) }
    records.append(String("\(kind)|v\(viewId)|\(purpose)|g\(generation)|\(state)|\(reason)".prefix(160)))
  }

  func noteAssigned(viewId: Int, purpose: String, view: MaoqiuPhotoPreviewView, generation: Int, first: Bool) {
    assignedImages += 1
    if first { note(viewId: viewId, purpose: purpose, view: view, kind: "A", generation: generation, reason: "first-assign") }
  }

  func noteDropped(viewId: Int, purpose: String, view: MaoqiuPhotoPreviewView, generation: Int, reason: String) {
    droppedCallbacks += 1
    note(viewId: viewId, purpose: purpose, view: view, kind: "D", generation: generation, reason: reason)
  }

  func noteCleared(viewId: Int, purpose: String, view: MaoqiuPhotoPreviewView, reason: String, generation: Int) {
    clearedImages += 1
    note(viewId: viewId, purpose: purpose, view: view, kind: "C", generation: generation, reason: reason)
  }

  func noteAnomaly(viewId: Int, purpose: String, view: MaoqiuPhotoPreviewView, generation: Int, reason: String) {
    layoutAnomalies += 1
    note(viewId: viewId, purpose: purpose, view: view, kind: "X", generation: generation, reason: reason)
  }

  func drain() -> [String: Any] {
    let events = records
    records = []
    let result: [String: Any] = [
      "assignedImages": assignedImages,
      "droppedCallbacks": droppedCallbacks,
      "clearedImages": clearedImages,
      "layoutAnomalies": layoutAnomalies,
      "events": events,
    ]
    assignedImages = 0; droppedCallbacks = 0; clearedImages = 0; layoutAnomalies = 0
    return result
  }
}

enum PhotoDelivery {
  case image(UIImage, degraded: Bool)
  case progress(Double)
  case failure(String)
  case cancelled
}

// One PhotoKit/cache/request budget shared by the feed, background and grid.
// All mutations run on the main queue; PhotoKit performs decoding asynchronously.
final class PhotoResources: NSObject {
  static let shared = PhotoResources()
  let manager = PHCachingImageManager()
  static let contentReady = Notification.Name("MaoqiuPhotoContentReady")
  private let cache = NSCache<NSString, UIImage>()
  private struct Task {
    let id: UUID
    let key: String
    let asset: PHAsset
    let size: CGSize
    let network: Bool
    var priority: Int
    var callbacks: [UUID: (PhotoDelivery) -> Void]
    var cloud = false
    var request = PHInvalidImageRequestID
    var epoch = UUID()
    var started: CFTimeInterval = 0
    var clock: PhotoLoadClock?
    var deadline: DispatchWorkItem?
    var deadlineEpoch = UUID()
  }
  private let previews = NSCache<NSString, UIImage>()
  private var monitor: NWPathMonitor?
  private var networkAvailable = true
  private var lastRecovery: CFTimeInterval = -100
  private var cloudFailures: [String: CFTimeInterval] = [:]
  private var cloudPauseUntil: CFTimeInterval = 0
  private var cloudRequests = 0.0, timeouts = 0.0, previewDeliveries = 0.0, offlineCount = 0.0
  static let availabilityChanged = Notification.Name("MaoqiuPhotoAvailabilityChanged")
  private var tasks: [UUID: Task] = [:]
  private var tokens: [UUID: UUID] = [:]
  private var preheated: [(PHAsset, CGSize)] = []
  private var interactive = false
  private var enabled = true
  private var constrained = false
  private var pressureUntil: CFTimeInterval = 0
  private var observers: [NSObjectProtocol] = []
  private var link: CADisplayLink?
  private var lastMemorySample: CFTimeInterval = 0
  private var sampledPeakMiB = 0.0
  private var lastFrame: CFTimeInterval = 0
  private var frames = 0.0, slowFrames = 0.0, maxFrameMs = 0.0
  private var hits = 0.0, requests = 0.0, ready = 0.0, loadMs = 0.0, errors = 0.0, cancelled = 0.0

  override init() {
    super.init()
    cache.totalCostLimit = 48 * 1024 * 1024
    cache.countLimit = 24
    previews.totalCostLimit = 12 * 1024 * 1024
    previews.countLimit = 24
    let center = NotificationCenter.default
    observers.append(center.addObserver(forName: UIApplication.didReceiveMemoryWarningNotification, object: nil, queue: .main) { [weak self] _ in
      self?.pressureUntil = CACurrentMediaTime() + 30
      self?.cache.removeAllObjects()
      self?.previews.removeAllObjects()
      self?.stopPreheat()
      self?.cancelBackground()
    })
    observers.append(center.addObserver(forName: ProcessInfo.thermalStateDidChangeNotification, object: nil, queue: .main) { [weak self] _ in self?.updatePressure() })
    observers.append(center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in self?.setWindow([], widths: [], heights: [], interactive: false, enabled: false) })
    updatePressure()
  }
  private var limited: Bool { constrained || CACurrentMediaTime() < pressureUntil }
  private func updatePressure() {
    constrained = ProcessInfo.processInfo.thermalState.rawValue >= ProcessInfo.ThermalState.serious.rawValue
    cache.totalCostLimit = constrained ? 16 * 1024 * 1024 : 48 * 1024 * 1024
    previews.totalCostLimit = constrained ? 4 * 1024 * 1024 : 12 * 1024 * 1024
    if constrained { cache.removeAllObjects(); previews.removeAllObjects(); stopPreheat(); cancelBackground() }
    pump()
  }
  static func size(_ width: CGFloat, _ height: CGFloat, cap: CGFloat = 4096) -> CGSize {
    // Stable 64-pixel buckets avoid repeated decode requests for layout jitter.
    CGSize(width: min(cap, max(64, ceil(width / 64) * 64)), height: min(cap, max(64, ceil(height / 64) * 64)))
  }
  private func key(_ id: String, _ size: CGSize) -> String { "\(id):\(Int(size.width))x\(Int(size.height))" }
  private func options(network: Bool) -> PHImageRequestOptions {
    let o = PHImageRequestOptions()
    o.isSynchronous = false; o.resizeMode = .fast; o.deliveryMode = .opportunistic; o.isNetworkAccessAllowed = network
    return o
  }
  func request(_ asset: PHAsset, size: CGSize, priority: Int, allowNetwork: Bool = false, callback: @escaping (PhotoDelivery) -> Void) -> UUID {
    let token = UUID(), k = key(asset.localIdentifier, size)
    if let image = cache.object(forKey: k as NSString) {
      hits += 1
      DispatchQueue.main.async { callback(.image(image, degraded: false)) }
      return token
    }
    // Local thumbnails always go first. Only current/adjacent content or an
    // explicitly visible grid may escalate to a cloud request.
    let network = priority <= 1 || allowNetwork
    if let id = tasks.first(where: { $0.value.key == k && ($0.value.network || !network) })?.key {
      var existing = tasks[id]!
      existing.callbacks[token] = callback
      existing.priority = min(existing.priority, priority)
      tasks[id] = existing
      tokens[token] = id
    } else {
      let id = UUID()
      tasks[id] = Task(id: id, key: k, asset: asset, size: size, network: network, priority: priority, callbacks: [token: callback])
      tokens[token] = id
      armDeadline(id, after: 8)
    }
    if let preview = previews.object(forKey: asset.localIdentifier as NSString) {
      DispatchQueue.main.async { [weak self] in
        guard self?.tokens[token] != nil else { return }
        callback(.image(preview, degraded: true))
      }
    }
    pump()
    return token
  }

  func retry(_ id: String) { cloudFailures.removeValue(forKey: id) }

  func cancel(_ token: UUID) {
    guard let id = tokens.removeValue(forKey: token) else { return }
    tasks[id]?.callbacks.removeValue(forKey: token)
    if let task = tasks[id], task.callbacks.isEmpty { remove(task) }
    pump()
  }

  private func remove(_ task: Task) {
    // Remove identity BEFORE cancelling: a late native callback cannot finish
    // a replacement request or release the same slot twice.
    tasks.removeValue(forKey: task.id)
    task.callbacks.keys.forEach { tokens.removeValue(forKey: $0) }
    task.deadline?.cancel()
    if task.request != PHInvalidImageRequestID { manager.cancelImageRequest(task.request) }
  }

  private func finish(_ task: Task, delivery: PhotoDelivery) {
    remove(task)
    Array(task.callbacks.values).forEach { $0(delivery) }
  }

  // Every scheduler termination reaches subscribers; explicit unsubscribe is
  // the only silent cancellation. No single stalled photo can own a slot forever.
  private func notifyCancelled(_ task: Task) {
    cancelled += Double(task.callbacks.count)
    finish(task, delivery: .cancelled)
  }

  private func fail(_ task: Task, reason: String) {
    errors += 1
    if reason.contains("timeout") { timeouts += 1 }
    if task.cloud && reason != "offline" && task.started > 0 {
      let now = CACurrentMediaTime()
      cloudFailures = cloudFailures.filter { now - $0.value < 30 }
      if cloudFailures.count >= 128, let oldest = cloudFailures.min(by: { $0.value < $1.value })?.key { cloudFailures.removeValue(forKey: oldest) }
      cloudFailures[task.asset.localIdentifier] = now
      if cloudFailures.count >= 3 { cloudPauseUntil = now + 20 }
    }
    finish(task, delivery: .failure(reason))
  }

  private func armDeadline(_ id: UUID, after delay: TimeInterval) {
    tasks[id]?.deadline?.cancel()
    let epoch = tasks[id]?.epoch
    let deadlineEpoch = UUID()
    tasks[id]?.deadlineEpoch = deadlineEpoch
    let work = DispatchWorkItem { [weak self] in
      guard let self, let task = self.tasks[id], task.epoch == epoch, task.deadlineEpoch == deadlineEpoch else { return }
      if task.started == 0 {
        self.fail(task, reason: "queue-timeout")
      } else if !task.cloud {
        self.timeouts += 1
        self.escalate(task)
      } else {
        self.fail(task, reason: "cloud-timeout")
      }
      self.pump()
    }
    tasks[id]?.deadline = work
    DispatchQueue.main.asyncAfter(deadline: .now() + max(0.01, delay), execute: work)
  }

  private func watchNetwork() {
    guard monitor == nil else { return }
    let watcher = NWPathMonitor()
    monitor = watcher
    watcher.pathUpdateHandler = { [weak self] path in
      DispatchQueue.main.async {
        guard let self else { return }
        let recovered = !self.networkAvailable && path.status == .satisfied
        self.networkAvailable = path.status == .satisfied
        if !self.networkAvailable {
          for task in Array(self.tasks.values) where task.cloud { self.fail(task, reason: "offline") }
        } else if recovered {
          self.cloudFailures.removeAll(); self.cloudPauseUntil = 0
          let now = CACurrentMediaTime()
          if now - self.lastRecovery >= 3 {
            self.lastRecovery = now
            NotificationCenter.default.post(name: Self.availabilityChanged, object: nil)
          }
        }
        self.pump()
      }
    }
    // Passive path observation only, no HTTP reachability probes.
    watcher.start(queue: DispatchQueue(label: "maoqiu.photo.network"))
  }

  private func escalate(_ task: Task) {
    guard task.network else { fail(task, reason: "cloud-required"); return }
    watchNetwork()
    guard networkAvailable else { offlineCount += 1; fail(task, reason: "offline"); return }
    let now = CACurrentMediaTime()
    if task.priority > 0 && (cloudPauseUntil > now || now - (cloudFailures[task.asset.localIdentifier] ?? -100) < 15) {
      fail(task, reason: "deferred")
      return
    }
    task.deadline?.cancel()
    var next = task
    next.epoch = UUID(); next.request = PHInvalidImageRequestID
    next.started = 0; next.clock = nil; next.cloud = true
    tasks[task.id] = next
    if task.request != PHInvalidImageRequestID { manager.cancelImageRequest(task.request) }
    armDeadline(task.id, after: 8)
  }

  private func cancelBackground() {
    for task in Array(tasks.values) where task.priority > 0 { notifyCancelled(task) }
  }

  private func pump() {
    guard enabled else { return }
    while true {
      var running = tasks.values.filter { $0.started > 0 }
      // A speculative cloud download must yield immediately to the current
      // photo, even when the byte/pixel budget has not been reached.
      if tasks.values.contains(where: { $0.started == 0 && $0.cloud && $0.priority == 0 }),
         let background = running.first(where: { $0.cloud && $0.priority > 0 }) {
        notifyCancelled(background)
        running = tasks.values.filter { $0.started > 0 }
      }
      let maxRunning = limited ? 1 : 3
      guard running.count < maxRunning else { return }
      let pixels = running.reduce(CGFloat(0)) { $0 + $1.size.width * $1.size.height }
      if tasks.values.contains(where: { $0.started == 0 && $0.priority == 0 }),
         let background = running.first(where: { $0.priority > 0 }), pixels > 8_000_000 {
        notifyCancelled(background)
        continue
      }
      let waiting = tasks.values.filter { $0.started == 0 }.sorted { $0.priority < $1.priority }
      guard var task = waiting.first(where: {
        ($0.priority == 0 || (!interactive && !limited && running.count < 2)) &&
        (!$0.cloud || !running.contains(where: { $0.cloud })) &&
        (running.isEmpty || pixels + $0.size.width * $0.size.height <= 24_000_000)
      }) else { return }
      if task.cloud && !networkAvailable { fail(task, reason: "offline"); continue }
      task.started = CACurrentMediaTime()
      task.clock = PhotoLoadClock(now: task.started)
      task.epoch = UUID()
      tasks[task.id] = task
      requests += 1
      if task.cloud { cloudRequests += 1 }
      let id = task.id, epoch = task.epoch, cloud = task.cloud
      let requestOptions = options(network: cloud)
      if cloud {
        requestOptions.progressHandler = { [weak self] progress, _, _, _ in
          DispatchQueue.main.async {
            guard let self, var current = self.tasks[id], current.epoch == epoch, progress.isFinite else { return }
            let previous = current.clock!.progress
            current.clock?.update(progress, now: CACurrentMediaTime())
            self.tasks[id] = current
            let deadline = current.clock!.deadline(cloud: true)
            self.armDeadline(id, after: deadline - CACurrentMediaTime())
            if Int(current.clock!.progress * 100) > Int(previous * 100) {
              Array(current.callbacks.values).forEach { $0(.progress(current.clock!.progress)) }
            }
          }
        }
        DispatchQueue.main.async { [weak self] in
          guard let current = self?.tasks[id], current.epoch == epoch else { return }
          Array(current.callbacks.values).forEach { $0(.progress(0)) }
        }
      }
      armDeadline(id, after: task.clock!.deadline(cloud: cloud) - CACurrentMediaTime())
      let request = manager.requestImage(for: task.asset, targetSize: task.size, contentMode: .aspectFit, options: requestOptions) { [weak self] image, info in
        DispatchQueue.main.async {
          guard let self, let current = self.tasks[id], current.epoch == epoch else { return }
          let degraded = (info?[PHImageResultIsDegradedKey] as? Bool) == true
          let wasCancelled = (info?[PHImageCancelledKey] as? Bool) == true
          let error = info?[PHImageErrorKey] as? NSError
          if wasCancelled {
            self.notifyCancelled(current)
          } else if let image {
            let cost = (image.cgImage?.bytesPerRow ?? Int(image.size.width * 4)) * (image.cgImage?.height ?? Int(image.size.height))
            if degraded {
              self.previewDeliveries += 1
              self.previews.setObject(image, forKey: current.asset.localIdentifier as NSString, cost: cost)
              Array(current.callbacks.values).forEach { $0(.image(image, degraded: true)) }
            } else {
              self.cache.setObject(image, forKey: current.key as NSString, cost: cost)
              self.cloudFailures.removeValue(forKey: current.asset.localIdentifier)
              self.ready += 1; self.loadMs += (CACurrentMediaTime() - current.started) * 1000
              self.finish(current, delivery: .image(image, degraded: false))
              NotificationCenter.default.post(name: Self.contentReady, object: current.asset.localIdentifier)
            }
          } else if !degraded || error != nil {
            let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
            if status != .authorized && status != .limited { self.fail(current, reason: "permission") }
            else if !cloud { self.escalate(current) }
            else { self.fail(current, reason: "cloud-failed") }
          }
          self.pump()
        }
      }
      tasks[id]?.request = request
    }
  }
  private func stopPreheat() {
    for (asset, size) in preheated {
      manager.stopCachingImages(for: [asset], targetSize: size, contentMode: .aspectFit, options: options(network: false))
    }
    preheated = []
  }
  func setWindow(_ ids: [String], widths: [Double], heights: [Double], interactive: Bool, enabled: Bool) {
    self.interactive = interactive; self.enabled = enabled
    stopPreheat()
    if enabled && link == nil {
      link = CADisplayLink(target: self, selector: #selector(tick(_:)))
      link?.add(to: .main, forMode: .common)
    } else if !enabled {
      link?.invalidate(); link = nil; lastFrame = 0
      for task in Array(tasks.values) { notifyCancelled(task) }
    }
    if enabled && !interactive && !limited {
      let scale = UIScreen.main.scale
      var remainingPixels: CGFloat = 8_000_000
      for i in 0..<min(ids.count, min(widths.count, heights.count)) {
        guard i < 2, let asset = PHAsset.fetchAssets(withLocalIdentifiers: [ids[i]], options: nil).firstObject else { continue }
        let size = Self.size(CGFloat(widths[i]) * scale, CGFloat(heights[i]) * scale)
        guard size.width * size.height <= remainingPixels else { continue }
        remainingPixels -= size.width * size.height
        manager.startCachingImages(for: [asset], targetSize: size, contentMode: .aspectFit, options: options(network: false))
        preheated.append((asset, size))
      }
    }
    pump()
  }
  @objc private func tick(_ sender: CADisplayLink) {
    if lastFrame > 0 {
      let gap = sender.timestamp - lastFrame
      let budget = sender.targetTimestamp - sender.timestamp
      frames += 1; maxFrameMs = max(maxFrameMs, gap * 1000)
      if budget > 0 && gap > budget * 1.5 { slowFrames += 1 }
    }
    lastFrame = sender.timestamp
    if sender.timestamp - lastMemorySample >= 1 {
      sampledPeakMiB = max(sampledPeakMiB, residentMiB())
      lastMemorySample = sender.timestamp
    }
  }
  private func residentMiB() -> Double {
    var info = mach_task_basic_info()
    var count = mach_msg_type_number_t(MemoryLayout<mach_task_basic_info>.size / MemoryLayout<integer_t>.size)
    let status = withUnsafeMutablePointer(to: &info) { pointer in
      pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(MACH_TASK_BASIC_INFO), $0, &count) }
    }
    return status == KERN_SUCCESS ? Double(info.resident_size) / 1048576 : -1
  }
  func snapshot() -> [String: Any] {
    let resident = residentMiB()
    sampledPeakMiB = max(sampledPeakMiB, resident)
    // Existing numeric fields keep their names and meanings; the display
    // diagnostics add five counters plus a bounded event array.
    var result: [String: Any] = ["frames": frames, "slowFrames": slowFrames, "maxFrameMs": maxFrameMs, "residentMiB": resident, "sampledPeakMiB": sampledPeakMiB,
                  "memoryCacheHits": hits, "imageRequests": requests, "readyImages": ready, "meanLoadMs": ready > 0 ? loadMs / ready : 0,
                  "errorCount": errors, "cancelledCount": cancelled,
                  "cloudRequests": cloudRequests, "timeoutCount": timeouts, "previewDeliveries": previewDeliveries, "offlineCount": offlineCount,
                  "activeRequests": Double(tasks.values.filter { $0.started > 0 }.count), "queuedRequests": Double(tasks.values.filter { $0.started == 0 }.count), "constrained": limited ? 1.0 : 0.0]
    for (k, v) in PhotoDiagnostics.shared.drain() { result[k] = v }
    frames = 0; slowFrames = 0; maxFrameMs = 0; hits = 0; requests = 0; ready = 0; loadMs = 0; errors = 0; cancelled = 0
    cloudRequests = 0; timeouts = 0; previewDeliveries = 0; offlineCount = 0
    return result
  }
}
