# 0067. Maia's look is version 7: two strands of hair

**Status:** Accepted (the owner, 2026-11-06)
**Date:** 2026-11-06

## Context
- The owner on her first hair: the tail needed a different shape; she could look like she's swimming. They then asked for hair "closer to "Today"" with "more strands in her hair like fire has multiple branches. 2 or 3 is what I'd like to see".
- Four fully animated rounds were turned down. Thin branches added to a tail looked spindly every time.
- So the next round was a sheet of still shapes with nothing animated: one flowing mass that divides at its end. The owner picked from it: "2 is the best. Make the smaller strand a bit smaller and ship it".

## Decision
- **Her look is `docs/assets/maia/`, version 7.** Don't change the rest shape, her colors, or her eyes and lashes without the owner's approval.
- **The hair:** a long outer strand curls around a short inner one, and both leave a wider neck than the old tail. The short strand is option 2's, scaled to 0.84.
- **It moves as one flame.** One wave passes through both strands, so the short strand has no motion of its own. The strands never cross in any measured frame.
- **The hair never returns to the old tail in motion.** `gentle` and the way down to sleep were rebuilt to avoid it. The long strand's S bend now peaks at 12 degrees, and above 10 only for moments.
- **Colors follow ADR 0065.** Only Dark's dark stop moved, from `#577CAF` to `#5F87BF`, to hold 3:1 on the new `surface.overlay`.
- **Moods, rhythms, beats and score are unchanged.** So are their names. Only descriptions that became untrue changed, such as `focused`.
- **`docs/assets/maia/README.md` is the motion spec.** `engine/` is a reference implementation; the package may restructure it as long as she looks and moves the same.

## Consequences
- **The owner approved version 7 in motion.** They first chose the shape from a still. After version 7 was published at the preview link, they said: "Maia 7 is great".
- **Approval isn't rollout.** Nothing goes into the product without the owner's own OK.
- **Known flaws are listed in the spec:** a stiff, nearly straight V for a moment mid-fall, a weaker curl in `focused`, more contact with the bubble wall than version 6, and soft tips at 32 px.
- **Chromium only so far,** and every frame-cost number comes from a machine with no GPU.
- **Sleeping after 5 minutes without use is still a default,** not the owner's decision.
