# Passive onboarding

First-frame value: photo cleanup is as easy as scrolling a feed. The title and
summary remain visible throughout; understanding never depends on watching a loop.
One CTA requests photo permission immediately. Existing upgrade-skip and permission
retry/limited-access handling remain unchanged.

`OnboardingExperience` is shared by first launch and menu replay. `OnboardingMotion`
uses local SVG outlines, a single native-driven progress value, transform and opacity.
There are no photos, practice state, touch handlers, media IDs, history or quota writes.
The 7.2-second loop shows browsing, a 1.15-second neutral pause, a delayed
decision label, left tilt before full-size left departure, and continued browsing.
The review receipt appears only after the departure finishes. No card shrinks away. Selection is never presented as immediate system deletion.

Animation starts after the motion preference resolves. Pause, background, Reduce Motion
and unmount stop the animation and reset to the first meaningful frame; foreground may
restart the decorative loop. No timers, frame-based React state or live announcements.
All text and the CTA remain usable with no animation. Menu help is a static reference;
the real feed never automatically displays teaching overlays.

## Device acceptance

- Check 320pt iPhones, current phones, iPad and large accessibility fonts in all six languages.
  The CTA stays visible; the central content can scroll if space is limited.
- Start at any point in the loop: full or limited authorization goes directly to the library.
  Denial offers settings and escape; permission failure reaches the existing retry gate.
- Watch several cycles; background/foreground, switch Reduce Motion, open a permission
  prompt and close menu replay. No orphan animation, touches intercepted or sounds.
- VoiceOver reads one stable illustration description, the value copy and the CTA.
  No repeated announcements of animation phases. The card art is decorative.
- Real-library history, favorites, pending photos, quota and startup layout are unaffected.

Automated JS/asset export and browser layout inspection do not replace native iOS gesture,
permission or VoiceOver acceptance on a physical device.
