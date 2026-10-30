---
name: Bug report
about: Something is broken or behaving incorrectly
labels: needs-triage
body:
  - type: markdown
    attributes:
      value: |
        Thanks for reporting! Fill in what you can — details make fixes faster.
  - type: input
    id: app-version
    attributes:
      label: App build number
      description: More menu → version row (e.g. 1.0.6 (58))
    validations:
      required: true
  - type: input
    id: ios-version
    attributes:
      label: iOS version and device
      description: e.g. iOS 18.3, iPhone 15 Pro
    validations:
      required: true
  - type: textarea
    id: steps
    attributes:
      label: Steps to reproduce
      placeholder: |
        1. ...
        2. ...
    validations:
      required: true
  - type: textarea
    id: expected
    attributes:
      label: Expected behavior
    validations:
      required: true
  - type: textarea
    id: actual
    attributes:
      label: Actual behavior
    validations:
      required: true
  - type: checkboxes
    id: library
    attributes:
      label: Library context
      options:
        - label: iCloud Photos enabled
        - label: Large library (>20k photos)
        - label: Lots of bursts
  - type: textarea
    id: notes
    attributes:
      label: Anything else?
      description: If the app showed an error card, long-press the version row in the More menu and paste the last diagnostic entries.
