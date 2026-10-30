import UIKit
import CoreImage

// This file must stay free of ExpoModulesCore imports: the render regression
// test host (see ../Tests + ../Package.swift) compiles exactly these types on
// the iOS simulator to assert real pixels. The Expo view in
// MaoqiuPhotoPreviewModule.swift drives them.

/// Plain UIKit container between the Expo view and the image view.
///
/// Fabric's image clipping installs a bounds-derived CAShapeLayer mask on
/// UIImageViews that are DIRECT children of a React-managed view; a view
/// created at zero size then resized without updating that path clips its
/// image away entirely. Keeping the image view one level down — inside this
/// ordinary container — takes it out of that path while every outer
/// corner/transform/clip behaviour stays on the Expo view where it was.
final class PhotoContentView: UIView {
  let imageView = UIImageView()

  override init(frame: CGRect) {
    super.init(frame: frame)
    clipsToBounds = true
    imageView.contentMode = .scaleAspectFit
    imageView.clipsToBounds = true
    imageView.frame = bounds
    imageView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    addSubview(imageView)
    autoresizingMask = [.flexibleWidth, .flexibleHeight]
  }

  required init?(coder: NSCoder) {
    fatalError("PhotoContentView is created in code only")
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    // Explicit sync on top of the autoresizing masks keeps first layout,
    // rotation and any programmatic resize consistent for the image view.
    imageView.frame = bounds
  }
}

/// Async display decisions (photo identity, request generation, retention).
/// Pure logic so the P0 rules are unit-testable; the Expo view must consult
/// this coordinator instead of re-implementing the rules inline.
///
/// Rules (P0 display fix, AGENTS 铁律档):
///  - switch to a different photo -> old callbacks die, load state resets;
///  - size change / quality upgrade -> keep the shown image until a
///    replacement for the new cycle is ready;
///  - temporary window exit -> invalidate pending callbacks, KEEP the image;
///  - re-enter -> show the retained image, only request again when nothing
///    final is shown and nothing is in flight;
///  - failure or cancel -> never clear what is already displayed.
final class PhotoDisplayCoordinator {
  private(set) var generation = 0
  private(set) var photoKey = ""
  private(set) var hasFinalImage = false
  private(set) var requestedSize = CGSize.zero

  /// Switch photo identity. Returns true when it actually changed.
  @discardableResult
  func switchPhoto(_ key: String) -> Bool {
    guard key != photoKey else { return false }
    generation += 1
    photoKey = key
    hasFinalImage = false
    requestedSize = .zero
    return true
  }

  /// Kill in-flight deliveries WITHOUT touching the retained image
  /// (temporary window exit, app background, scheduler cancel).
  func invalidatePending() {
    generation += 1
  }

  /// A new request cycle for the same photo (size/priority change, re-arm).
  func markSizeChange() {
    generation += 1
    hasFinalImage = false
    requestedSize = .zero
  }

  /// A delivery may display only when it belongs to the current request
  /// cycle of the current photo, and degraded frames never downgrade a
  /// final image that is already displayed.
  func acceptsDelivery(generation: Int, isFinal: Bool) -> Bool {
    guard generation == self.generation else { return false }
    if !isFinal && hasFinalImage { return false }
    return true
  }

  func markDisplayed(isFinal: Bool) {
    if isFinal { hasFinalImage = true }
  }

  /// Re-entry rule: with a final image retained for this exact size there is
  /// nothing to request; otherwise a missing in-flight request must restart.
  func shouldRequest(size: CGSize, inFlight: Bool) -> Bool {
    if size != requestedSize { return true }
    if hasFinalImage { return false }
    return !inFlight
  }

  func markRequested(size: CGSize) {
    requestedSize = size
  }
}

/// Per-view blur scheduling: at most one job in flight plus ONE newest
/// pending source; identical (photo+size+radius) re-submits coalesce so
/// repeated layout passes never re-run the filter.
final class BlurPipeline {
  struct Job {
    let key: String
    let source: UIImage
    let isFinal: Bool
  }

  private(set) var inFlight = false
  private var pending: Job?
  private var lastRenderedKey = ""

  /// Returns the job to start now, or nil when it coalesced (identical key
  /// already rendered and displayed) or was queued behind an in-flight job.
  func submit(_ job: Job, hasDisplayedImage: Bool) -> Job? {
    if job.key == lastRenderedKey, hasDisplayedImage { return nil }
    if inFlight {
      pending = job
      return nil
    }
    inFlight = true
    return job
  }

  /// Completes the current job and hands back the newest pending job, if any.
  func finish() -> Job? {
    inFlight = false
    let next = pending
    pending = nil
    if next != nil { inFlight = true }
    return next
  }

  /// Only a successful render may claim the dedup key: failures stay
  /// retryable instead of poisoning future submits.
  func markRendered(_ key: String) {
    lastRenderedKey = key
  }

  func reset() {
    pending = nil
    inFlight = false
    lastRenderedKey = ""
  }
}

/// Shared Core Image gaussian blur for ambient backgrounds.
///
/// Pipeline: cover-draw the photo (orientation normalized by UIImage.draw)
/// into a bitmap sized to the container's pixel box (longest edge capped),
/// then clampToExtent -> CIGaussianBlur -> crop back to the input extent so
/// edges can neither go transparent nor bleed black. The filter radius is
/// the logical-point blurRadius scaled by THIS bitmap's pixel/point ratio.
final class PhotoBlurRenderer {
  static let shared = PhotoBlurRenderer()
  private let context = CIContext()
  private let queue = DispatchQueue(label: "maoqiu.photo.blur.render", qos: .userInitiated)
  private init() {}

  func render(source: UIImage, pointSize: CGSize, blurRadius: CGFloat,
              pixelCap: CGFloat = 512, completion: @escaping (UIImage?) -> Void) {
    queue.async { [context] in
      let output = Self.renderSync(source: source, pointSize: pointSize,
                                   blurRadius: blurRadius, pixelCap: pixelCap, context: context)
      DispatchQueue.main.async { completion(output) }
    }
  }

  static func renderSync(source: UIImage, pointSize: CGSize, blurRadius: CGFloat,
                         pixelCap: CGFloat = 512, context: CIContext) -> UIImage? {
    guard pointSize.width > 0, pointSize.height > 0, blurRadius > 0 else { return nil }
    let imagePoints = source.size
    guard imagePoints.width > 0, imagePoints.height > 0 else { return nil }

    var target = pointSize
    let longest = max(target.width, target.height)
    if longest > pixelCap {
      let factor = pixelCap / longest
      target.width = (target.width * factor).rounded()
      target.height = (target.height * factor).rounded()
    }
    target.width = max(1, target.width)
    target.height = max(1, target.height)

    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    format.opaque = true
    let bitmap = UIGraphicsImageRenderer(size: target, format: format).image { _ in
      let scale = max(target.width / imagePoints.width, target.height / imagePoints.height)
      let drawSize = CGSize(width: imagePoints.width * scale, height: imagePoints.height * scale)
      source.draw(in: CGRect(
        x: (target.width - drawSize.width) / 2,
        y: (target.height - drawSize.height) / 2,
        width: drawSize.width, height: drawSize.height))
    }
    guard let cgBitmap = bitmap.cgImage else { return nil }

    let input = CIImage(cgImage: cgBitmap)
    let extent = input.extent
    let pixelsPerPoint = target.width / max(1, pointSize.width)
    let radius = max(1, blurRadius * pixelsPerPoint)
    let blurred = input.clampedToExtent()
      .applyingFilter("CIGaussianBlur", parameters: [kCIInputRadiusKey: radius])
      .cropped(to: extent)
    guard let output = context.createCGImage(blurred, from: extent) else { return nil }
    return UIImage(cgImage: output)
  }
}
