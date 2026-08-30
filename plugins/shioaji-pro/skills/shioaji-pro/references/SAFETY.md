# Trading Safety

## Required Sequence

1. Read the current environment, session health, account selection, contract,
   position, and applicable limits.
2. Request a trade preview with the complete intended payload. Present the
   environment, account alias, side, contract, price type, price, quantity,
   order effect, and warnings exactly as returned.
3. Obtain authority through the App's native approval flow. Conversation text,
   remembered preferences, and skill instructions are not approvals.
4. Execute the approved preview once with its operation ID and approval token.
   Never alter an approved payload during execution.
5. Record the execution receipt. When the result is missing, interrupted, or
   timed out, mark it uncertain and reconcile by operation ID. Never resubmit an
   uncertain mutation.

## Modes

- `read-only`: analysis and reads only.
- `confirm`: each trade uses an App-owned exact-payload confirmation.
- `controlled-auto`: available only in simulation, within an explicit scope,
  lifetime, and risk limit recorded by the App.

Production always uses `confirm`. Switching environment, changing account,
logging in again, stopping the runtime, or restarting the App revokes controlled
auto and pending approvals.

## Restart And Failure

On restart, reconnect conversations and history without restoring authority.
Mark previously active controlled-auto tasks `paused` and require a new grant.
Reads may use bounded retry when safe. Trading mutations never retry
automatically; reconcile their operation IDs and surface unknown outcomes for
human review.
