@main
struct PhotoRequestPolicyTests {
  static func check(_ actual: Bool, _ expected: Bool, _ name: String) {
    guard actual == expected else { fatalError("Policy failed: \(name)") }
  }
  static func main() {
    func run(_ priority: Int, _ running: Int, _ interactive: Bool, _ limited: Bool) -> Bool {
      PhotoRequestPolicy.mayStart(priority: priority, running: running, interactive: interactive, limited: limited)
    }
    check(run(0, 0, true, true), true, "current under interaction and pressure")
    check(run(1, 0, true, true), true, "visible neighbour under interaction and pressure")
    check(run(1, 0, false, true), true, "visible grid under pressure")
    check(run(1, 1, true, true), false, "pressure bounds concurrency")
    check(run(1, 1, true, false), true, "visible neighbour during swipe")
    check(run(1, 2, false, false), false, "reserve current slot")
    check(run(0, 2, true, false), true, "current uses reserved slot")
    check(run(2, 0, true, false), false, "defer speculation during swipe")
    check(run(2, 0, false, true), false, "defer speculation under pressure")
    check(run(2, 1, false, false), true, "idle speculation remains available")
    print("Photo request policy: 10 cases passed")
  }
}
