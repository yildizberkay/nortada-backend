# 0009 — Registered profiles win anonymous merge conflicts; anonymous preferences fill gaps

- **Status:** accepted
- **Date:** 2026-07-23
- **Scope:** nortada-backend (drives nortada-app-ios account linking)

## Context

A user can use Nortada anonymously, complete onboarding, and create data before
signing into a Clerk account that already exists. The original D-008 policy
preserved the registered account but left every anonymous preference row on the
retired identity, including rows for sports the registered account had never
configured. That avoided accidental overwrites but discarded useful,
non-conflicting preferences and accumulated dead rows.

## Options considered

1. **Anonymous profile wins** — rejected because accidental onboarding would overwrite the user's established account preferences.
2. **Discard every anonymous preference** — rejected because preferences absent from the registered account can be preserved without a conflict.
3. **Registered target wins conflicts; anonymous rows fill gaps** — chosen.

## Decision

During a branch-2 anonymous-to-existing-account merge, the target account's
global `user_profile` wins if present; otherwise the anonymous global profile is
reassigned. Per-sport profiles use the same rule independently by sport: target
rows win collisions and non-colliding anonymous rows are reassigned. Losing
anonymous rows are deleted inside the same transaction instead of remaining on
the retired identity.

Identity attributes such as verified email and name are not profile-merge
inputs; Clerk remains their source of truth. Activities, equipment, favorites,
and private spots retain their existing owned-data merge policies.

## Evidence

`user_profile.user_id` is unique and `user_sport_profile` is unique on
`(user_id, sport)`, so blindly changing ownership can violate both constraints.
`user-profile.repository.spec.ts` covers target-present collisions and
target-absent gap filling. The auth merge already runs every reassigner, token
revocation, and source retirement in one database transaction.

## Consequences

- Accidental anonymous onboarding never overwrites an established profile.
- A registered account with no global or per-sport preference keeps useful
  anonymous configuration instead of falling back to defaults.
- A global profile is treated as one coherent unit; fields from two onboarding
  states are never mixed into an invalid combination.
- Conflicting anonymous preference rows are intentionally deleted after the
  target wins; rollback restores them if any later merge step fails.
- Every future user-owned preference table must define an explicit collision
  policy and join the merge reassigner before shipping.

## Revisit when

The product introduces explicit profile-conflict UI, per-device preferences, or
multi-device synchronization semantics where “target account wins” no longer
matches user expectations.
