import type { GraphicsState } from './protocol.js';

export const EVENT_TYPE_IDS = ['golf', 'cricket', 'football', 'wedding', 'concert', 'conference', 'other'] as const;
export type EventType = (typeof EVENT_TYPE_IDS)[number];

/**
 * What changes with the kind of event: the words the app uses and which graphics start on.
 * Golf keeps hole cards, scores and the leaderboard; other events start with a clean picture
 * and a name caption (lower third) labelled for that kind of event.
 */
export interface EventProfile {
  id: EventType;
  label: string;
  /** Camera setup asks for this (golf: the hole); null = no position question. */
  positionLabel: string | null;
  /** Golf scoring, hole cards, leaderboard and score bug. */
  scoring: boolean;
  /** Labels of the name caption's two lines. */
  captionTitle: string;
  captionSubtitle: string;
  /** Example text shown in the empty caption fields. */
  captionExample: string;
}

export const EVENT_TYPES: Record<EventType, EventProfile> = {
  golf: { id: 'golf', label: 'Golf', positionLabel: 'Hole', scoring: true, captionTitle: 'Player', captionSubtitle: 'Club or score', captionExample: 'Aarav Mehta · DLF Golf' },
  cricket: { id: 'cricket', label: 'Cricket', positionLabel: null, scoring: false, captionTitle: 'Player', captionSubtitle: 'Team', captionExample: 'Riya Sharma · Gurgaon XI' },
  football: { id: 'football', label: 'Football', positionLabel: null, scoring: false, captionTitle: 'Player', captionSubtitle: 'Team', captionExample: 'Kabir Singh · City FC' },
  wedding: { id: 'wedding', label: 'Wedding', positionLabel: null, scoring: false, captionTitle: 'Names', captionSubtitle: 'Occasion', captionExample: 'Ananya & Rohan · Sangeet' },
  concert: { id: 'concert', label: 'Concert', positionLabel: null, scoring: false, captionTitle: 'Artist', captionSubtitle: 'Song', captionExample: 'The Local Band · Opening set' },
  conference: { id: 'conference', label: 'Conference', positionLabel: null, scoring: false, captionTitle: 'Speaker', captionSubtitle: 'Title and company', captionExample: 'Dr Meera Iyer · CTO, Acme' },
  other: { id: 'other', label: 'Other', positionLabel: null, scoring: false, captionTitle: 'Name', captionSubtitle: 'Details', captionExample: 'Name · Details' },
};

export function eventProfile(type: string | null | undefined): EventProfile {
  return EVENT_TYPES[(type ?? 'golf') as EventType] ?? EVENT_TYPES.other;
}

/** Starting graphics for a new event of this type (merged over the defaults). */
export function initialGraphics(type: EventType): Partial<GraphicsState> {
  if (EVENT_TYPES[type].scoring) return {};
  return {
    holeCard: { auto: false, visible: false, hole: null, durationSec: 8 },
    scoreBug: { visible: false },
    leaderboard: { visible: false, size: 8, category: null },
  };
}
