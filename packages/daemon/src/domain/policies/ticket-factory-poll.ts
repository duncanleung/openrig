// RIG-88: watchdog policy that drives the ticket-factory poll. The tick only wakes the
// controller; the poll itself runs detached (see TicketFactoryController.triggerPoll), so a
// slow tracker call never delays other supervision jobs.

import type { Policy, PolicyEvaluation } from "./types.js";

export const TICKET_FACTORY_POLL_POLICY = "ticket-factory-poll";
export const TICKET_FACTORY_POLL_TARGET = "ticket-factory-poll@kernel";

export function makeTicketFactoryPollPolicy(deps: { trigger: () => void }): Policy {
  return {
    name: TICKET_FACTORY_POLL_POLICY,
    async evaluate(): Promise<PolicyEvaluation> {
      deps.trigger();
      return { action: "skip", reason: "poll triggered" };
    },
  } as Policy;
}
