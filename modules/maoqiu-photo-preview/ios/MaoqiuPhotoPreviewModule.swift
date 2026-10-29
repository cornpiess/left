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
    AsyncFunction("getPerformanceSnapshot") { () -> [String: Double] in
      PhotoResources.shared.snapshot()
    }.runOnQueue(.main)
    View(MaoqiuPhotoPreviewView.self) {
      Events("onLoad", "onError")
      Prop("assetId") { (view: MaoqiuPhotoPreviewView, value: String) in view.setAsset(value) }
      Prop("resizeMode") { (view: MaoqiuPhotoPreviewView, value: String) in
        view.imageView.contentMode = value == "cover" ? .scaleAspectFill : .scaleAspectFit
      }
      Prop("maxPixelSize") { (view: MaoqiuPhotoPreviewView, value: Double) in view.maxPixelSize = CGFloat(max(64, min(4096, value))); view.setNeedsLayout() }
      Prop("networkAccess") { (view: MaoqiuPhotoPreviewView, value: Bool) in view.networkAccess = value }
      Prop("priority") { (view: MaoqiuPhotoPreviewView, value: Int) in view.requestPriority = value }
      Prop("blurred") { (view: MaoqiuPhotoPreviewView, value: Bool) in view.blurView.isHidden = !value }
      Prop("resolutionScale") { (view: MaoqiuPhotoPreviewView, value: Double) in
        view.resolutionScale = CGFloat(max(1, min(4, value)))
        view.setNeedsLayout()
      }
    }
  }
}

final class MaoqiuPhotoPreviewView: ExpoView {
  let imageView = UIImageView()
  let blurView = UIVisualEffectView(effect: UIBlurEffect(style: .dark))
  let onLoad = EventDispatcher()
  let onError = EventDispatcher()
  var resolutionScale: CGFloat = 1
  var requestPriority = 1 { didSet {
    guard oldValue != requestPriority, !hasFinalImage else { return }
    requestedSize = .zero; setNeedsLayout()
  } }
  var networkAccess = false { didSet { if oldValue != networkAccess && !hasFinalImage { requestedSize = .zero; setNeedsLayout() } } }
  var maxPixelSize: CGFloat = 4096
  private var assetId = ""
  private var hasFinalImage = false
  private var generation = 0
  private var token: UUID?
  private var requestedSize = CGSize.zero
  private var observers: [NSObjectProtocol] = []

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    imageView.contentMode = .scaleAspectFit; imageView.clipsToBounds = true
    addSubview(imageView); blurView.isHidden = true; addSubview(blurView)
    observers.append(NotificationCenter.default.addObserver(forName: PhotoResources.contentReady, object: nil, queue: .main) { [weak self] note in
      guard let self, self.imageView.image == nil, note.object as? String == self.assetId else { return }
      self.requestedSize = .zero; self.setNeedsLayout()
    })
    observers.append(NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
      self?.cancel(); self?.requestedSize = .zero
    })
    observers.append(NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in self?.setNeedsLayout() })
  }
  func setAsset(_ value: String) {
    let id = value.hasPrefix("ph://") ? String(value.dropFirst(5)) : value
    guard id != assetId else { return }
    cancel(); assetId = id; hasFinalImage = false; imageView.image = nil; requestedSize = .zero; setNeedsLayout()
  }
  private func cancel() {
    generation += 1
    if let token { PhotoResources.shared.cancel(token) }
    token = nil
  }
  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil { cancel(); requestedSize = .zero; imageView.image = nil; hasFinalImage = false }
    else { setNeedsLayout() }
  }
  override func layoutSubviews() {
    super.layoutSubviews(); imageView.frame = bounds; blurView.frame = bounds
    guard window != nil, bounds.width > 0, bounds.height > 0, !assetId.isEmpty else { return }
    let scale = window?.screen.scale ?? 2
    let size = PhotoResources.size(bounds.width * scale * resolutionScale, bounds.height * scale * resolutionScale, cap: maxPixelSize)
    guard size != requestedSize else { return }
    cancel(); hasFinalImage = false; requestedSize = size
    let version = generation
    guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [assetId], options: nil).firstObject else {
      onError(["assetId": assetId]); return
    }
    token = PhotoResources.shared.request(asset, size: size, priority: requestPriority, allowNetwork: networkAccess) { [weak self] image, degraded, wasCancelled in
      guard let self, self.generation == version, self.window != nil else { return }
      if let image {
        self.imageView.image = image
        self.hasFinalImage = !degraded
        if !degraded { self.onLoad(["assetId": self.assetId]) }
        return
      }
      if wasCancelled {
        // The scheduler dropped this request (memory pressure, eviction,
        // window toggle). Re-arm after a staggered delay so the surface
        // recovers instead of staying black forever.
        self.hasFinalImage = false
        self.requestedSize = .zero
        let delay = 0.35 + Double.random(in: 0...0.5)
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
          guard let self, self.window != nil, !self.hasFinalImage, self.imageView.image == nil else { return }
          self.requestedSize = .zero
          self.setNeedsLayout()
        }
      } else if !degraded {
        self.onError(["assetId": self.assetId])
      }
    }
  }
  deinit { observers.forEach { NotificationCenter.default.removeObserver($0) }; if let token { PhotoResources.shared.cancel(token) } }
}

