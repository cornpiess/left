// swift-tools-version:5.9
// Native render regression host for the P0 photo-display fix.
//
// Compiles the PRODUCTION UIKit types from ios/PhotoContentView.swift (the
// same file the app pod builds) and asserts real rendered pixels on the iOS
// simulator — no signing, no app build. Run from this directory:
//   xcodebuild test -scheme MaoqiuPhotoPreview \
//     -destination 'platform=iOS Simulator,name=<any iPhone>'
import PackageDescription

let package = Package(
  name: "MaoqiuPhotoPreview",
  platforms: [.iOS(.v16)],
  targets: [
    .target(name: "PhotoPreviewCore", path: "ios", sources: ["PhotoContentView.swift"]),
    .testTarget(name: "RenderTests", dependencies: ["PhotoPreviewCore"], path: "Tests"),
  ]
)
