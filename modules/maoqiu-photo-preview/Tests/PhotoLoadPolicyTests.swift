import XCTest
@testable import PhotoPreviewCore

final class PhotoLoadPolicyTests: XCTestCase {
  func testLocalProbeCannotHoldTheQueueForever() {
    let clock = PhotoLoadClock(now: 100)
    XCTAssertEqual(clock.deadline(cloud: false), 102.5)
    XCTAssertEqual(clock.deadline(cloud: true), 112)
  }

  func testOnlyAdvancingProgressExtendsStallDeadline() {
    var clock = PhotoLoadClock(now: 0)
    clock.update(0.2, now: 5)
    XCTAssertEqual(clock.deadline(cloud: true), 17)
    clock.update(0.2, now: 10)
    clock.update(0.1, now: 11)
    clock.update(.nan, now: 12)
    XCTAssertEqual(clock.deadline(cloud: true), 17)
    XCTAssertEqual(clock.progress, 0.2)
  }

  func testProgressCanNeverExtendAbsoluteDeadline() {
    var clock = PhotoLoadClock(now: 0)
    clock.update(0.2, now: 10)
    clock.update(0.4, now: 20)
    clock.update(1, now: 29)
    XCTAssertEqual(clock.deadline(cloud: true), 30)
  }

  func testTransientErrorsHaveOneAutomaticForegroundRetry() {
    var budget = PhotoRetryBudget()
    XCTAssertNil(budget.delay(reason: "cloud-failed", foreground: false))
    XCTAssertEqual(budget.delay(reason: "cloud-timeout", foreground: true), 0.8)
    XCTAssertNil(budget.delay(reason: "cloud-failed", foreground: true))
  }

  func testOfflineAndPermissionFailuresWaitForExplicitRecovery() {
    var budget = PhotoRetryBudget()
    for reason in ["offline", "asset-missing", "permission", "deferred"] {
      XCTAssertNil(budget.delay(reason: reason, foreground: true))
    }
    XCTAssertEqual(budget.delay(reason: "cloud-failed", foreground: true), 0.8)
  }

  func testSchedulerCancellationsCannotCreateAnInfiniteRetryLoop() {
    var budget = PhotoRetryBudget()
    XCTAssertEqual(budget.delay(reason: "cancelled", foreground: false), 0.4)
    XCTAssertEqual(budget.delay(reason: "cancelled", foreground: false), 0.8)
    XCTAssertNil(budget.delay(reason: "cancelled", foreground: true))
    XCTAssertEqual(budget.delay(reason: "cloud-failed", foreground: true), 0.8)
  }
}
