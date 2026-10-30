import ExpoModulesCore
import Photos
import UIKit

public class MaoqiuPhotoPreviewModule: Module {
  public func definition() -> ModuleDefinition {
    Name("MaoqiuPhotoPreview")
    AsyncFunction("deleteAssets") { (ids: [String]) async throws -> Bool in
      do {
        try await PHPhotoLibrary.shared().performChanges {
          let assets = PHAsset.fetchAssets(withLocalIdentifiers: ids, options: nil)
          PHAssetChangeRequest.deleteAssets(assets)
        }
        return true
      } catch {
        let nativeError = error as NSError
        if nativeError.domain == PHPhotosErrorDomain && nativeError.code == PHPhotosError.Code.userCancelled.rawValue { return false }
        throw error
      }
    }
    AsyncFunction("getBurstIdentifiers") { (ids: [String]) -> [String: String] in
      var result: [String: String] = [:]
      PHAsset.fetchAssets(withLocalIdentifiers: ids, options: nil).enumerateObjects { asset, _, _ in
        if let burst = asset.burstIdentifier { result[asset.localIdentifier] = burst }
      }
      return result
    }
    AsyncFunction("getAccessibleAssetIds") { (ids: [String]) -> [String] in
      var result: [String] = []
      PHAsset.fetchAssets(withLocalIdentifiers: ids, options: nil).enumerateObjects { asset, _, _ in
        result.append(asset.localIdentifier)
      }
      return result
    }
    AsyncFunction("getBurstMembers") { (identifier: String, offset: Int, limit: Int) -> [String: Any] in
      let options = PHFetchOptions()
      options.includeAllBurstAssets = true
      options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: true)]
      let assets = PHAsset.fetchAssets(withBurstIdentifier: identifier, options: options)
      let start = max(0, min(offset, assets.count))
      let end = min(assets.count, start + max(1, min(limit, 160)))
      var items: [[String: Any]] = []
      if start < end {
        for index in start..<end {
          let asset = assets.object(at: index)
          var subtypes: [String] = []
          if asset.mediaSubtypes.contains(.photoLive) { subtypes.append("livePhoto") }
          if asset.mediaSubtypes.contains(.photoScreenshot) { subtypes.append("screenshot") }
          if asset.mediaSubtypes.contains(.photoPanorama) { subtypes.append("panorama") }
          items.append(["id": asset.localIdentifier, "mediaType": "photo",
            "width": asset.pixelWidth, "height": asset.pixelHeight,
            "creationTime": (asset.creationDate?.timeIntervalSince1970 ?? 0) * 1000,
            "duration": asset.duration, "mediaSubtypes": subtypes,
            "nativeBurstId": identifier, "nativeBurstCount": assets.count,
            "nativeBurstOffset": end])
        }
      }
      return ["items": items, "count": assets.count, "nextOffset": end]
    }
    AsyncFunction("setMediaWindow") { (ids: [String], widths: [Double], heights: [Double], interactive: Bool, enabled: Bool) in
      PhotoResources.shared.setWindow(ids, widths: widths, heights: heights, interactive: interactive, enabled: enabled)
    }.runOnQueue(.main)
    AsyncFunction("getPerformanceSnapshot") { () -> [String: Any] in
      PhotoResources.shared.snapshot()
    }.runOnQueue(.main)
    View(MaoqiuPhotoPreviewView.self) {
      Events("onLoad", "onError")
      Prop("assetId") { (view: MaoqiuPhotoPreviewView, value: String) in view.setAsset(value) }
      Prop("resizeMode") { (view: MaoqiuPhotoPreviewView, value: String) in
        view.contentView.imageView.contentMode = value == "cover" ? .scaleAspectFill : .scaleAspectFit
      }
      Prop("maxPixelSize") { (view: MaoqiuPhotoPreviewView, value: Double) in view.maxPixelSize = CGFloat(max(64, min(4096, value))); view.setNeedsLayout() }
      Prop("networkAccess") { (view: MaoqiuPhotoPreviewView, value: Bool) in view.networkAccess = value }
      Prop("priority") { (view: MaoqiuPhotoPreviewView, value: Int) in view.requestPriority = value }
      Prop("purpose") { (view: MaoqiuPhotoPreviewView, value: String) in view.purpose = value }
      Prop("blurRadius") { (view: MaoqiuPhotoPreviewView, value: Double) in
        view.blurRadius = CGFloat(max(0, min(100, value)))
      }
      Prop("resolutionScale") { (view: MaoqiuPhotoPreviewView, value: Double) in
        view.resolutionScale = CGFloat(max(1, min(4, value)))
        view.setNeedsLayout()
      }
    }
  }
}

/// Expo-facing photo surface.
///
/// View hierarchy (P0 display fix — see AGENTS 构建与发版铁律/same incident):
///   MaoqiuPhotoPreviewView (ExpoView: React props, layout, rounding, transforms)
///   └── PhotoContentView (plain UIKit: inner clipping, cover/contain)
///       └── UIImageView (display only — NOT a direct ExpoView child)
final class MaoqiuPhotoPreviewView: ExpoView {
  let contentView = PhotoContentView()
  var imageView: UIImageView { contentView.imageView }
  let onLoad = EventDispatcher()
  let onError = EventDispatcher()
  var purpose = "feed"
  var resolutionScale: CGFloat = 1
  var requestPriority = 1 { didSet {
    guard oldValue != requestPriority, !coordinator.hasFinalImage else { return }
    coordinator.markSizeChange(); setNeedsLayout()
  } }
  var networkAccess = false { didSet { if oldValue != networkAccess && !coordinator.hasFinalImage { coordinator.markSizeChange(); setNeedsLayout() } } }
  var maxPixelSize: CGFloat = 4096
  var blurRadius: CGFloat = 0 { didSet {
    guard blurRadius != oldValue else { return }
    blurPipeline.reset()
    blurVersion &+= 1
    if blurRadius > 0, let source = sourceImage, bounds.width > 0, bounds.height > 0 {
      submitBlur(source: source, isFinal: coordinator.hasFinalImage)
    }
  } }

  private let viewId: Int
  private let coordinator = PhotoDisplayCoordinator()
  private let blurPipeline = BlurPipeline()
  private var blurVersion = 0
  private var sourceImage: UIImage?
  private var token: UUID?
  private var reportedFirstAssign = false
  private var anomalyReportedGeneration = -1
  private var observers: [NSObjectProtocol] = []

  required init(appContext: AppContext? = nil) {
    viewId = PhotoDiagnostics.shared.nextViewId()
    super.init(appContext: appContext)
    dispatchPrecondition(condition: .onQueue(.main))
    clipsToBounds = true
    contentView.frame = bounds
    contentView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    addSubview(contentView)
    observers.append(NotificationCenter.default.addObserver(forName: PhotoResources.contentReady, object: nil, queue: .main) { [weak self] note in
      guard let self, self.imageView.image == nil, note.object as? String == self.coordinator.photoKey else { return }
      self.coordinator.markSizeChange(); self.setNeedsLayout()
    })
    observers.append(NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
      // App-level "temporary leave": subscriptions die, the shown image stays.
      self?.cancelRequest()
      self?.coordinator.invalidatePending()
    })
    observers.append(NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in self?.setNeedsLayout() })
  }

  func setAsset(_ value: String) {
    dispatchPrecondition(condition: .onQueue(.main))
    let id = value.hasPrefix("ph://") ? String(value.dropFirst(5)) : value
    guard coordinator.switchPhoto(id) else { return }
    cancelRequest()
    imageView.image = nil
    sourceImage = nil
    blurPipeline.reset()
    blurVersion &+= 1
    reportedFirstAssign = false
    anomalyReportedGeneration = -1
    PhotoDiagnostics.shared.noteCleared(viewId: viewId, purpose: purpose, view: self, reason: "switch", generation: coordinator.generation)
    setNeedsLayout()
  }

  private func cancelRequest() {
    if let token { PhotoResources.shared.cancel(token) }
    token = nil
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil {
      // Temporary leave: subscriptions and late callbacks die; the displayed
      // image and its load state are RETAINED (P0 retention rule).
      cancelRequest()
      coordinator.invalidatePending()
    } else {
      setNeedsLayout()
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    dispatchPrecondition(condition: .onQueue(.main))
    contentView.frame = bounds
    guard window != nil, bounds.width > 0, bounds.height > 0, !coordinator.photoKey.isEmpty else { return }
    checkDisplayAnomaly()
    let scale = window?.screen.scale ?? 2
    let size = PhotoResources.size(bounds.width * scale * resolutionScale, bounds.height * scale * resolutionScale, cap: maxPixelSize)
    guard coordinator.shouldRequest(size: size, inFlight: token != nil) else { return }
    startRequest(size: size)
  }

  private func startRequest(size: CGSize) {
    cancelRequest()
    coordinator.markSizeChange()
    coordinator.markRequested(size: size)
    let version = coordinator.generation
    guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [coordinator.photoKey], options: nil).firstObject else {
      PhotoDiagnostics.shared.note(viewId: viewId, purpose: purpose, view: self, kind: "F", generation: version, reason: "asset-missing")
      onError(["assetId": coordinator.photoKey])
      return
    }
    token = PhotoResources.shared.request(asset, size: size, priority: requestPriority, allowNetwork: networkAccess) { [weak self] image, degraded, wasCancelled in
      self?.handleDelivery(image: image, degraded: degraded, wasCancelled: wasCancelled, version: version)
    }
  }

  private func handleDelivery(image: UIImage?, degraded: Bool, wasCancelled: Bool, version: Int) {
    dispatchPrecondition(condition: .onQueue(.main))
    if version == coordinator.generation { token = nil }
    guard coordinator.acceptsDelivery(generation: version, isFinal: !degraded) else {
      if version != coordinator.generation {
        PhotoDiagnostics.shared.noteDropped(viewId: viewId, purpose: purpose, view: self, generation: version, reason: "late-callback")
      }
      return
    }
    if let image {
      display(image, isFinal: !degraded)
      return
    }
    if wasCancelled {
      // Scheduler dropped this request (memory pressure, eviction, window
      // toggle): re-arm after a stagger. The shown image is never cleared.
      coordinator.invalidatePending()
      let delay = 0.35 + Double.random(in: 0...0.5)
      DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
        guard let self, self.window != nil, !self.coordinator.hasFinalImage, self.imageView.image == nil else { return }
        self.coordinator.markSizeChange()
        self.setNeedsLayout()
      }
    } else if !degraded {
      PhotoDiagnostics.shared.note(viewId: viewId, purpose: purpose, view: self, kind: "F", generation: version, reason: "load-failed")
      onError(["assetId": coordinator.photoKey])
    }
  }

  private func display(_ image: UIImage, isFinal: Bool) {
    if blurRadius > 0 {
      // Ambient path: never show the sharp photo; the blurred result swaps
      // in only when it is ready, the previous backdrop stays until then.
      if isFinal { sourceImage = image }
      submitBlur(source: image, isFinal: isFinal)
    } else {
      imageView.image = image
      coordinator.markDisplayed(isFinal: isFinal)
      PhotoDiagnostics.shared.noteAssigned(viewId: viewId, purpose: purpose, view: self,
                                           generation: coordinator.generation, first: !reportedFirstAssign)
      reportedFirstAssign = true
      // onLoad only reports "committed to the view", never screen compositing.
      if isFinal { onLoad(["assetId": coordinator.photoKey]) }
    }
    checkDisplayAnomaly()
  }

  private func blurKey() -> String {
    "\(coordinator.photoKey)|\(Int(bounds.width))x\(Int(bounds.height))|\(Int(blurRadius))"
  }

  private func submitBlur(source: UIImage, isFinal: Bool) {
    guard bounds.width > 0, bounds.height > 0 else {
      if isFinal { onError(["assetId": coordinator.photoKey]) }
      return
    }
    guard let job = blurPipeline.submit(BlurPipeline.Job(key: blurKey(), source: source, isFinal: isFinal),
                                        hasDisplayedImage: imageView.image != nil) else {
      // Coalesced: this exact content is already blurred and displayed.
      if isFinal {
        coordinator.markDisplayed(isFinal: true)
        PhotoDiagnostics.shared.noteAssigned(viewId: viewId, purpose: purpose, view: self,
                                             generation: coordinator.generation, first: !reportedFirstAssign)
        reportedFirstAssign = true
        onLoad(["assetId": coordinator.photoKey])
      }
      return
    }
    runBlur(job)
  }

  private func runBlur(_ job: BlurPipeline.Job) {
    let version = coordinator.generation
    let blurSnapshot = blurVersion
    let pointSize = bounds.size
    PhotoBlurRenderer.shared.render(source: job.source, pointSize: pointSize, blurRadius: blurRadius) { [weak self] result in
      guard let self else { return }
      dispatchPrecondition(condition: .onQueue(.main))
      guard version == self.coordinator.generation, blurSnapshot == self.blurVersion else {
        PhotoDiagnostics.shared.noteDropped(viewId: self.viewId, purpose: self.purpose, view: self, generation: version, reason: "blur-stale")
        if let next = self.blurPipeline.finish() { self.runBlur(next) }
        return
      }
      guard let result else {
        // Blur failed: keep the existing backdrop, stay retryable, surface it.
        PhotoDiagnostics.shared.note(viewId: self.viewId, purpose: self.purpose, view: self, kind: "F", generation: version, reason: "blur-failed")
        if job.isFinal { self.onError(["assetId": self.coordinator.photoKey]) }
        if let next = self.blurPipeline.finish() { self.runBlur(next) }
        return
      }
      self.imageView.image = result
      self.blurPipeline.markRendered(job.key)
      self.coordinator.markDisplayed(isFinal: job.isFinal)
      PhotoDiagnostics.shared.noteAssigned(viewId: self.viewId, purpose: self.purpose, view: self,
                                           generation: self.coordinator.generation, first: !self.reportedFirstAssign)
      self.reportedFirstAssign = true
      if job.isFinal { self.onLoad(["assetId": self.coordinator.photoKey]) }
      self.checkDisplayAnomaly()
      if let next = self.blurPipeline.finish() { self.runBlur(next) }
    }
  }

  // ---- Display-chain diagnostics (bounded, main-thread; no photo IDs) ----

  private func maskStateDescription() -> String {
    var parts: [String] = []
    for (role, layer) in [("i", imageView.layer), ("c", contentView.layer)] {
      if let shape = layer.mask as? CAShapeLayer {
        let box = shape.path?.boundingBoxOfPath ?? .zero
        parts.append("\(role):B\(Int(box.width))x\(Int(box.height))")
      } else if layer.mask != nil {
        parts.append("\(role):O")
      }
    }
    return parts.isEmpty ? "0" : parts.joined(separator: "/")
  }

  private func checkDisplayAnomaly() {
    guard imageView.image != nil, anomalyReportedGeneration != coordinator.generation else { return }
    var reasons: [String] = []
    if imageView.bounds.width < 1 || imageView.bounds.height < 1 ||
       contentView.bounds.width < 1 || contentView.bounds.height < 1 {
      reasons.append("zero-frame")
    }
    for (role, layer) in [("i", imageView.layer), ("c", contentView.layer)] {
      if let shape = layer.mask as? CAShapeLayer {
        let box = shape.path?.boundingBoxOfPath ?? .zero
        if box.width < 1 || box.height < 1 { reasons.append("mask-\(role)-empty") }
      }
    }
    guard !reasons.isEmpty else { return }
    anomalyReportedGeneration = coordinator.generation
    PhotoDiagnostics.shared.noteAnomaly(viewId: viewId, purpose: purpose, view: self,
                                        generation: coordinator.generation, reason: reasons.joined(separator: ","))
  }

  deinit {
    observers.forEach { NotificationCenter.default.removeObserver($0) }
    if let token { PhotoResources.shared.cancel(token) }
  }
}
