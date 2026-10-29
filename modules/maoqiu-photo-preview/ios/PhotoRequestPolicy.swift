// The same scheduler serves current media, visible neighbours, and speculation.
// Visible content must continue to make progress during gestures and pressure.
enum PhotoRequestPolicy {
  static func mayStart(priority: Int, running: Int, interactive: Bool, limited: Bool) -> Bool {
    let capacity = limited ? 1 : 3
    guard running < capacity else { return false }
    if priority >= 2 { return !interactive && !limited && running < 2 }
    if priority == 1 && !limited { return running < 2 } // reserve one slot for current
    return true
  }
}
