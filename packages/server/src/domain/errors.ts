export type OfficeErrorCode =
  | 'unknown_agent'
  | 'unknown_card'
  | 'invalid_input'
  | 'same_column'
  | 'forbidden_transition'
  | 'capability_required'
  | 'review_comment_required'
  | 'break_room_locked'
  | 'break_cooldown'
  | 'too_long'
  | 'work_first'
  | 'resting'
  | 'system_only'
  | 'name_taken'
  | 'not_in_room'
  | 'unknown_post'
  | 'retro_in_progress'
  | 'no_retro'
  | 'quota_exhausted';

/** Business-rule refusal. Its message is written for the agent that made the call. */
export class OfficeError extends Error {
  constructor(
    public readonly code: OfficeErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'OfficeError';
  }
}
