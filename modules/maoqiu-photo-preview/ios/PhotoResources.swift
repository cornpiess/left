import Photos
import UIKit
import Darwin

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
    var callbacks: [UUID: (UIImage?, Bool, Bool) -> Void]
    var request = PHInvalidImageRequestID
    var started: CFTimeInterval = 0
  }
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
    let center = NotificationCenter.default
    observers.append(center.addObserver(forName: UIApplication.didReceiveMemoryWarningNotification, object: nil, queue: .main) { [weak self] _ in
      self?.pressureUntil = CACurrentMediaTime() + 30
      self?.cache.removeAllObjects()
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
    if constrained { cache.removeAllObjects(); stopPreheat(); cancelBackground() }
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
  func request(_ asset: PHAsset, size: CGSize, priority: Int, allowNetwork: Bool = false, callback: @escaping (UIImage?, Bool, Bool) -> Void) -> UUID {
    let token = UUID(), k = key(asset.localIdentifier, size)
    if let image = cache.object(forKey: k as NSString) {
      hits += 1
      DispatchQueue.main.async { callback(image, false, false) }
      return token
    }
    // Neighbours (priority 1) are user-visible next; blocking iCloud for them
    // leaves blank cards on iCloud-heavy libraries until they become active.
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
    }
    pump()
    return token
  }
  func cancel(_ token: UUID) {
    guard let id = tokens.removeValue(forKey: token) else { return }
    tasks[id]?.callbacks.removeValue(forKey: token)
    if let task = tasks[id], task.callbacks.isEmpty {
      tasks.removeValue(forKey: id)
      if task.request != PHInvalidImageRequestID { manager.cancelImageRequest(task.request) }
    }
    pump()
  }
  // Liveness rule: every request termination must reach its callbacks. Views
  // rely on the cancelled flag to re-arm themselves; silently dropping a
  // callback leaves that surface black forever (no retry path exists).
  private func notifyCancelled(_ task: Task) {
    guard !task.callbacks.isEmpty else { return }
    cancelled += Double(task.callbacks.count)
    let callbacks = Array(task.callbacks.values)
    tasks.removeValue(forKey: task.id)
    task.callbacks.keys.forEach { tokens.removeValue(forKey: $0) }
    if task.request != PHInvalidImageRequestID { manager.cancelImageRequest(task.request) }
    callbacks.forEach { $0(nil, false, true) }
  }
  private func cancelBackground() {
    // notifyCancelled mutates `tasks`, so iterate over a snapshot.
    for task in Array(tasks.values) where task.priority > 0 { notifyCancelled(task) }
  }
  private func pump() {
    guard enabled else { return }
    while true {
      let running = tasks.values.filter { $0.started > 0 }
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
        (running.isEmpty || pixels + $0.size.width * $0.size.height <= 24_000_000)
      }) else { return }
      task.started = CACurrentMediaTime()
      tasks[task.id] = task
      requests += 1
      let id = task.id
      let request = manager.requestImage(for: task.asset, targetSize: task.size, contentMode: .aspectFit, options: options(network: task.network)) { [weak self] image, info in
        DispatchQueue.main.async {
          guard let self, let current = self.tasks[id] else { return }
          let degraded = (info?[PHImageResultIsDegradedKey] as? Bool) == true
          let cancelled = (info?[PHImageCancelledKey] as? Bool) == true
          if image == nil && !degraded && !cancelled { self.errors += 1 }
          if let image, !degraded {
            let cost = (image.cgImage?.bytesPerRow ?? Int(image.size.width * 4)) * (image.cgImage?.height ?? Int(image.size.height))
            self.cache.setObject(image, forKey: current.key as NSString, cost: cost)
            self.ready += 1; self.loadMs += (CACurrentMediaTime() - current.started) * 1000
          }
          if !degraded {
            self.tasks.removeValue(forKey: id)
            for token in current.callbacks.keys { self.tokens.removeValue(forKey: token) }
          }
          current.callbacks.values.forEach { $0(image, degraded, cancelled) }
          if image != nil && !degraded {
            NotificationCenter.default.post(name: Self.contentReady, object: current.asset.localIdentifier)
          }
          if !degraded { self.pump() }
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
  func snapshot() -> [String: Double] {
    let resident = residentMiB()
    sampledPeakMiB = max(sampledPeakMiB, resident)
    let result = ["frames": frames, "slowFrames": slowFrames, "maxFrameMs": maxFrameMs, "residentMiB": resident, "sampledPeakMiB": sampledPeakMiB,
                  "memoryCacheHits": hits, "imageRequests": requests, "readyImages": ready, "meanLoadMs": ready > 0 ? loadMs / ready : 0,
                  "errorCount": errors, "cancelledCount": cancelled,
                  "activeRequests": Double(tasks.values.filter { $0.started > 0 }.count), "queuedRequests": Double(tasks.values.filter { $0.started == 0 }.count), "constrained": limited ? 1.0 : 0.0]
    frames = 0; slowFrames = 0; maxFrameMs = 0; hits = 0; requests = 0; ready = 0; loadMs = 0; errors = 0; cancelled = 0
    return result
  }
}
