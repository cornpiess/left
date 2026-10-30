import XCTest
import UIKit
@testable import PhotoPreviewCore

/// Pixel-level render regression for the P0 black-photo fix.
///
/// These tests render the PRODUCTION PhotoContentView hierarchy through
/// CALayer.render into an RGBA bitmap and assert actual pixel colors —
/// `image != nil` is never accepted as evidence of visibility.
///
/// Scope note: this host replays the confirmed Fabric clipping OPERATION
/// (a bounds-derived CAShapeLayer mask applied to a direct UIImageView
/// child). It is not a React Native end-to-end device acceptance.
final class PhotoContentViewRenderTests: XCTestCase {

  // ---- helpers ------------------------------------------------------------

  private func solidImage(_ color: UIColor, _ size: CGSize) -> UIImage {
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    return UIGraphicsImageRenderer(size: size, format: format).image { ctx in
      color.setFill()
      ctx.fill(CGRect(origin: .zero, size: size))
    }
  }

  /// Rasterize a view's layer tree into RGBA pixels (row 0 = top row).
  private func rasterize(_ view: UIView) -> CGImage? {
    let w = max(1, Int(view.bounds.width.rounded()))
    let h = max(1, Int(view.bounds.height.rounded()))
    guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8,
                              bytesPerRow: w * 4, space: CGColorSpaceCreateDeviceRGB(),
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
    ctx.translateBy(x: 0, y: CGFloat(h))
    ctx.scaleBy(x: 1, y: -1)
    view.layer.render(in: ctx)
    return ctx.makeImage()
  }

  private func pixel(_ image: CGImage, _ x: Int, _ y: Int) -> (r: UInt8, g: UInt8, b: UInt8, a: UInt8) {
    let w = image.width, h = image.height
    let cx = min(max(0, x), w - 1), cy = min(max(0, y), h - 1)
    guard let data = image.dataProvider?.data, let bytes = CFDataGetBytePtr(data) else { return (0, 0, 0, 0) }
    let bpp = image.bitsPerPixel / 8
    let rowBytes = image.bytesPerRow
    // CG raster is bottom-left origin; callers use top-left coordinates.
    let offset = (h - 1 - cy) * rowBytes + cx * bpp
    return (bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3])
  }

  private func assertRedish(_ p: (r: UInt8, g: UInt8, b: UInt8, a: UInt8), _ place: String,
                            file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertTrue(p.r > 180 && p.g < 80 && p.b < 80 && p.a > 200,
                  "\(place): expected red, got \(p)", file: file, line: line)
  }

  private func assertBlueish(_ p: (r: UInt8, g: UInt8, b: UInt8, a: UInt8), _ place: String,
                             file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertTrue(p.b > 180 && p.r < 80 && p.a > 200,
                  "\(place): expected blue, got \(p)", file: file, line: line)
  }

  /// Production wiring: a plain root (the ExpoView stand-in) hosting the
  /// PhotoContentView as its ONLY direct child.
  private func makeProductionTree() -> (root: UIView, content: PhotoContentView) {
    let root = UIView(frame: .zero)
    let content = PhotoContentView(frame: .zero)
    root.addSubview(content)
    return (root, content)
  }

  private func layout(_ view: UIView) {
    view.setNeedsLayout()
    view.layoutIfNeeded()
  }

  // ---- 1. zero-size creation, then normal size: first image visible -------

  func testZeroSizeCreationThenResizeShowsFirstImage() {
    let (root, content) = makeProductionTree()
    root.frame = CGRect(x: 0, y: 0, width: 375, height: 500)
    layout(root)
    // Aspect-matched so contain fills the box with no letterbox bands.
    content.imageView.image = solidImage(.red, CGSize(width: 375, height: 500))
    layout(content)
    let shot = XCTAssertNotNilAndUnwrap(rasterize(root))
    assertRedish(pixel(shot, 187, 250), "center")
    assertRedish(pixel(shot, 10, 10), "corner")
  }

  // ---- 2. replay of the Fabric direct-image-child masking operation -------

  func testFabricMaskReplayCannotReachNestedImageView() {
    // Control — the OLD structure: UIImageView as a direct child, masked
    // with a path derived from ZERO-size bounds and never updated. This
    // documents the failure mode the fix removes.
    let oldRoot = UIView(frame: .zero)
    let direct = UIImageView()
    direct.image = solidImage(.red, CGSize(width: 200, height: 300))
    direct.contentMode = .scaleAspectFill
    oldRoot.addSubview(direct)
    let staleMask = CAShapeLayer()
    staleMask.path = CGPath(rect: .zero, transform: nil) // bounds were zero at clip time
    direct.layer.mask = staleMask
    oldRoot.frame = CGRect(x: 0, y: 0, width: 300, height: 300)
    direct.frame = oldRoot.bounds
    layout(oldRoot)
    let oldShot = XCTAssertNotNilAndUnwrap(rasterize(oldRoot))
    let oldCenter = pixel(oldShot, 150, 150)
    XCTAssertFalse(oldCenter.r > 180 && oldCenter.g < 80 && oldCenter.b < 80,
                   "control: stale zero-bounds mask hides the direct image child (mechanism confirmed)")

    // Production — same masking operation replayed against the direct
    // children of the root: the image view is one level down, so the rule
    // finds no UIImageView to mask and the photo stays visible.
    let (root, content) = makeProductionTree()
    root.frame = CGRect(x: 0, y: 0, width: 300, height: 300)
    layout(root)
    content.imageView.image = solidImage(.red, CGSize(width: 200, height: 300))
    layout(content)
    let imageChildren = root.subviews.compactMap { $0 as? UIImageView }
    XCTAssertTrue(imageChildren.isEmpty, "no UIImageView may be a direct child of the Expo view")
    // Replay exactly the operation: mask every direct UIImageView child.
    for child in imageChildren {
      let mask = CAShapeLayer()
      mask.path = CGPath(rect: .zero, transform: nil)
      child.layer.mask = mask
    }
    let shot = XCTAssertNotNilAndUnwrap(rasterize(root))
    assertRedish(pixel(shot, 150, 150), "center after mask replay")
  }

  // ---- 3. resize after assignment: image stays, no residual empty mask ----

  func testImageSurvivesResizeAfterAssignment() {
    let (root, content) = makeProductionTree()
    root.frame = CGRect(x: 0, y: 0, width: 300, height: 300)
    layout(root)
    content.imageView.image = solidImage(.red, CGSize(width: 300, height: 300))
    layout(content)
    var shot = XCTAssertNotNilAndUnwrap(rasterize(root))
    assertRedish(pixel(shot, 150, 150), "before resize")
    root.frame = CGRect(x: 0, y: 0, width: 150, height: 600)
    layout(root)
    layout(content)
    shot = XCTAssertNotNilAndUnwrap(rasterize(root))
    assertRedish(pixel(shot, 75, 300), "after resize")
    XCTAssertNil(content.imageView.layer.mask, "no residual mask on the image view")
  }

  // ---- 4. cover / contain + outer rounded-corner clipping -----------------

  func testCoverContainAndOuterCornerClipping() {
    let root = UIView(frame: CGRect(x: 0, y: 0, width: 300, height: 300))
    root.backgroundColor = .blue
    root.layer.cornerRadius = 40
    root.clipsToBounds = true
    let content = PhotoContentView(frame: root.bounds)
    content.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    root.addSubview(content)
    layout(root)

    // cover: photo fills the box; the rounded corner must not leak photo
    // content — outside the corner curve nothing of the image may appear
    // (the corner also clips the root's own background, so transparent is
    // exactly as valid as background blue there).
    content.imageView.contentMode = .scaleAspectFill
    content.imageView.image = solidImage(.red, CGSize(width: 100, height: 50))
    layout(content)
    var shot = XCTAssertNotNilAndUnwrap(rasterize(root))
    assertRedish(pixel(shot, 150, 150), "cover center")
    let corner = pixel(shot, 4, 4)
    XCTAssertFalse(corner.r > 180 && corner.g < 80 && corner.b < 80 && corner.a > 200,
                   "cover corner must not leak the photo outside the rounded corner, got \(corner)")

    // contain (wide photo in a square box): letterbox bands on top and bottom.
    content.imageView.contentMode = .scaleAspectFit
    layout(content)
    shot = XCTAssertNotNilAndUnwrap(rasterize(root))
    assertRedish(pixel(shot, 150, 150), "contain center")
    assertBlueish(pixel(shot, 150, 6), "contain top band")
    assertBlueish(pixel(shot, 150, 293), "contain bottom band")
  }

  // ---- 5. repeated layout never re-runs the blur --------------------------

  func testRepeatedLayoutDoesNotRedundantlyReblur() {
    let pipeline = BlurPipeline()
    let red = solidImage(.red, CGSize(width: 100, height: 100))
    let jobA = BlurPipeline.Job(key: "photo|100x100|40", source: red, isFinal: true)

    let started = pipeline.submit(jobA, hasDisplayedImage: false)
    XCTAssertTrue(started != nil, "idle pipeline starts the first job")
    pipeline.markRendered(jobA.key)

    // Re-layout with the same photo, size and radius: coalesced, no job.
    XCTAssertNil(pipeline.submit(jobA, hasDisplayedImage: true),
                 "identical key with displayed image must not re-render")

    // While a job is in flight only the NEWEST pending source is kept.
    let pipeline2 = BlurPipeline()
    XCTAssertNotNil(pipeline2.submit(jobA, hasDisplayedImage: false))
    let jobB = BlurPipeline.Job(key: "photo2|100x100|40", source: red, isFinal: true)
    let jobC = BlurPipeline.Job(key: "photo3|100x100|40", source: red, isFinal: true)
    XCTAssertNil(pipeline2.submit(jobB, hasDisplayedImage: false), "queued behind in-flight job")
    XCTAssertNil(pipeline2.submit(jobC, hasDisplayedImage: false), "newest pending replaces older pending")
    let next = XCTAssertNotNilAndUnwrap(pipeline2.finish())
    XCTAssertEqual(next.key, jobC.key, "only the newest pending job survives")
    XCTAssertNil(pipeline2.finish(), "pending slot drained")
  }

  // ---- 6. temporary window exit keeps the displayed image -----------------

  func testTemporaryWindowExitKeepsDisplayedImage() {
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 320, height: 480))
    let (root, content) = makeProductionTree()
    root.frame = window.bounds
    window.addSubview(root)
    window.makeKeyAndVisible()
    layout(window)
    content.imageView.image = solidImage(.red, CGSize(width: 200, height: 200))
    layout(content)
    XCTAssertNotNil(content.imageView.image)

    root.removeFromSuperview() // temporary leave
    XCTAssertNotNil(content.imageView.image, "leave must retain the image")
    layout(content)
    XCTAssertNotNil(content.imageView.image)

    window.addSubview(root) // re-enter
    layout(window)
    layout(content)
    XCTAssertNotNil(content.imageView.image, "re-mount must keep the retained image")
    let shot = XCTAssertNotNilAndUnwrap(rasterize(root))
    assertRedish(pixel(shot, 160, 240), "center after remount")
  }

  // ---- 7. A -> B switch: A's late async result may never win --------------

  func testLateDeliveryFromPreviousPhotoIsRejected() {
    let coordinator = PhotoDisplayCoordinator()
    coordinator.switchPhoto("A")
    let versionA = coordinator.generation
    XCTAssertTrue(coordinator.acceptsDelivery(generation: versionA, isFinal: true))

    coordinator.switchPhoto("B")
    let versionB = coordinator.generation
    XCTAssertFalse(coordinator.acceptsDelivery(generation: versionA, isFinal: true),
                   "late final from A must be rejected after switching to B")
    XCTAssertTrue(coordinator.acceptsDelivery(generation: versionB, isFinal: true))

    // Degraded frames never downgrade a displayed final (same photo).
    coordinator.markDisplayed(isFinal: true)
    XCTAssertFalse(coordinator.acceptsDelivery(generation: versionB, isFinal: false))
    XCTAssertTrue(coordinator.acceptsDelivery(generation: versionB, isFinal: true))

    // Re-entry: retained final for the same size means no new request.
    XCTAssertTrue(coordinator.shouldRequest(size: CGSize(width: 300, height: 300), inFlight: false))
    coordinator.markRequested(size: CGSize(width: 300, height: 300))
    coordinator.markDisplayed(isFinal: true)
    XCTAssertFalse(coordinator.shouldRequest(size: CGSize(width: 300, height: 300), inFlight: false),
                   "retained final image needs no re-request")
    XCTAssertFalse(coordinator.shouldRequest(size: CGSize(width: 300, height: 300), inFlight: true))
    // Window exit keeps the final: only a real size change re-requests.
    coordinator.invalidatePending()
    XCTAssertFalse(coordinator.shouldRequest(size: CGSize(width: 300, height: 300), inFlight: false))
    XCTAssertTrue(coordinator.shouldRequest(size: CGSize(width: 400, height: 300), inFlight: false))
    // Size change clears finality so the replacement may display.
    coordinator.markSizeChange()
    XCTAssertFalse(coordinator.hasFinalImage)
    XCTAssertTrue(coordinator.shouldRequest(size: CGSize(width: 400, height: 300), inFlight: false))
  }

  // ---- 8. background blur: color kept, no dark/transparent edges, capped --

  func testBlurRendererKeepsColorEdgesAndRespectsCap() {
    let blue = solidImage(.blue, CGSize(width: 400, height: 400))
    let context = CIContext()
    let blurred = XCTAssertNotNilAndUnwrap(PhotoBlurRenderer.renderSync(
      source: blue, pointSize: CGSize(width: 100, height: 100), blurRadius: 40, context: context))
    XCTAssertLessThanOrEqual(max(blurred.size.width, blurred.size.height), 512,
                             "bitmap longest edge must respect the 512px cap")
    // A solid blue input blurred is still blue everywhere: edges prove the
    // clamp+crop kept color instead of leaking transparency or black.
    let blurredView = UIImageView(image: blurred)
    blurredView.frame = CGRect(origin: .zero, size: blurred.size)
    let shot = XCTAssertNotNilAndUnwrap(rasterize(blurredView))
    for (x, y) in [(2, 2), (Int(blurred.size.width) - 3, 2), (2, Int(blurred.size.height) - 3),
                   (Int(blurred.size.width) - 3, Int(blurred.size.height) - 3),
                   (Int(blurred.size.width) / 2, Int(blurred.size.height) / 2)] {
      assertBlueish(pixel(shot, x, y), "blurred(\(x),\(y))")
    }

    // Oversized containers clamp to the cap instead of exploding.
    let capped = XCTAssertNotNilAndUnwrap(PhotoBlurRenderer.renderSync(
      source: blue, pointSize: CGSize(width: 1000, height: 800), blurRadius: 40, context: context))
    XCTAssertLessThanOrEqual(max(capped.size.width, capped.size.height), 512)
  }
}

/// Unwrap helper that keeps the failure message readable.
private func XCTAssertNotNilAndUnwrap<T>(_ value: T?, file: StaticString = #filePath, line: UInt = #line) -> T {
  guard let unwrapped = value else {
    XCTFail("expected non-nil value", file: file, line: line)
    fatalError("unreachable after XCTFail")
  }
  return unwrapped
}
