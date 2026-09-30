// Public surface of the brain module.
export { Brain, sharedJevLink, MAX_IN_FLIGHT, BAND_INTERVAL_S, type BrainOptions, type IntentCallback } from './brain';
export { JevLink, MAX_REQUESTS_PER_S, RETRY_MS, type JevLinkOptions, type AskFn, type HealthFn, type LinkHealth } from './link';
export { createLocalLink, sharedLocalLink, probeLocalHealth, LOCAL_JEV_ENDPOINT } from './local-link';
export { askJev, JevError, JEV_MODEL, type JevQuestion, type JevAnswer, type JevResult } from './jev-client';
export { serializeState, type FightState } from './serializer';
export { buildQuestions, type QuestionSet } from './questions';
export { makeFighterContext, readSituation, coarseKey, type FighterContext, type Situation } from './situation';
export { houseMind, obviousDecision } from './house-mind';
export type { BrainDecision, BrainFrame, BrainStats, DecisionSource, CommitMode, JevStatus, MatchClock, LatencySummary, MindSource, MindLinkKind, MindLinkStatus } from './types';
