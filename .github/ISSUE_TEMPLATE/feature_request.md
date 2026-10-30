---
name: Feature request
about: Suggest an idea for LeftSwipe
labels: needs-triage
body:
  - type: textarea
    id: problem
    attributes:
      label: What problem are you trying to solve?
      description: Tell us what bothers you, not just the solution you have in mind.
    validations:
      required: true
  - type: textarea
    id: solution
    attributes:
      label: What would you like to happen?
    validations:
      required: true
  - type: markdown
    attributes:
      value: |
        Note: the product's core principles (see docs/CORE_PRD.md) are treated as
        immutable — ideas that require breaking them (e.g. cloud photo upload,
        re-suggesting already-seen photos) will be declined.
