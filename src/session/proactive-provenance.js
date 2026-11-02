import {stateOf} from '../core/result.js';

const SENT_STATES = new Set(['submitted', 'accepted', 'confirmed']);

export function recordProactiveConversation({event, result, actions, execution, conversation, message, text}) {
  if (event?.reason !== 'social' || !SENT_STATES.has(stateOf(result))) return false;
  const actual = actions.sentMessages(execution).at(-1);
  conversation.sent(
    {...message, id: ''},
    result.data?.message_id,
    actual?.text || String(text),
    event.evidence
  );
  return true;
}
