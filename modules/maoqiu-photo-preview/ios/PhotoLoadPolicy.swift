import Foundation

// Shared by every PhotoKit surface. Only advancing progress extends the idle
// deadline; repeated callbacks can never extend the absolute deadline.
struct PhotoLoadClock {
  static let localTimeout: TimeInterval = 2.5
  static let stallTimeout: TimeInterval = 12
  static let cloudTimeout: TimeInterval = 30
  let started: TimeInterval
  private(set) var advanced: TimeInterval
  private(set) var progress = 0.0

  init(now: TimeInterval) { started = now; advanced = now }

  mutating func update(_ value: Double, now: TimeInterval) {
    guard value.isFinite, value > progress else { return }
    progress = min(1, max(0, value))
    advanced = now
  }

  func deadline(cloud: Bool) -> TimeInterval {
    cloud ? min(started + Self.cloudTimeout, advanced + Self.stallTimeout) : started + Self.localTimeout
  }
}

// Layout passes are not retries. One automatic transient retry per foreground
// visit; scheduler cancellations have their own small budget. User retry and
// an actual network recovery explicitly reset this budget.
struct PhotoRetryBudget {
  private var failures = 0
  private var cancellations = 0

  mutating func delay(reason: String, foreground: Bool) -> TimeInterval? {
    if reason == "cancelled" {
      guard cancellations < 2 else { return nil }
      cancellations += 1
      return 0.4 * Double(cancellations)
    }
    guard foreground, !["asset-missing", "permission", "offline", "deferred"].contains(reason), failures < 1 else { return nil }
    failures += 1
    return 0.8
  }
}
