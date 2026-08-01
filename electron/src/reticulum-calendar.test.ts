import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import moment from 'moment-timezone';
import {
  expandReticulumCalendarMutation,
  findNextReticulumCalendarOccurrence,
  normalizeReticulumCalendarInput,
  type ReticulumCalendarMutation,
  type ReticulumCalendarRecurrence,
} from './reticulum-calendar';
import { ReticulumChatDatabase } from './reticulum-chat-db';
import {
  byteLengthUtf8JsonWithBridgeSenderOnly,
  RT_RETICULUM_MAX_WIRE_JSON_BYTES,
  wireFitsReticulumChat,
} from './reticulum-wire-size';

const uuid = (suffix: string) =>
  `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`;

const mutation = (
  eventId: string,
  startLocal: string,
  recurrence: ReticulumCalendarRecurrence | null
): ReticulumCalendarMutation => ({
  version: 1,
  mutationId: uuid('2'),
  operation: 'upsert',
  eventId,
  groupId: 1144,
  timestamp: 1_700_000_000_000,
  state: {
    eventId,
    groupId: 1144,
    title: 'Calendar test',
    description: '',
    location: '',
    link: '',
    allDay: false,
    timezone: 'Europe/Bucharest',
    startLocal,
    endLocal: startLocal.replace('10:00:00', '11:00:00'),
    recurrence,
  },
  authorAddress: 'Qauthor',
  authorPublicKey: 'public-key',
  signature: 'signature',
});

describe('Reticulum group calendar', () => {
  it('keeps the largest calendar resource notice inside the wire ceiling', () => {
    const notice = {
      t: 'RCHAT',
      k: 'calendar_offer_v1',
      g: 2_147_483_647,
      w: {
        x: 'f'.repeat(16),
        k: 's',
        i: `${'f'.repeat(16)}-9999`,
        h: 'f'.repeat(64),
        s: 64 * 1024,
      },
    };
    expect(wireFitsReticulumChat(notice)).toBe(true);
    expect(byteLengthUtf8JsonWithBridgeSenderOnly(notice)).toBeLessThanOrEqual(
      RT_RETICULUM_MAX_WIRE_JSON_BYTES
    );
  });

  it('normalizes only bounded events with an IANA time zone', () => {
    const eventId = uuid('1');
    expect(
      normalizeReticulumCalendarInput(1144, eventId, {
        title: 'Planning',
        description: 'Monthly planning meeting',
        allDay: false,
        timezone: 'Europe/Bucharest',
        startLocal: '2026-08-10T10:00:00',
        endLocal: '2026-08-10T11:00:00',
        recurrence: { frequency: 'monthly', untilLocalDate: '2027-08-10' },
      })
    ).toMatchObject({ title: 'Planning', timezone: 'Europe/Bucharest' });
    expect(
      normalizeReticulumCalendarInput(1144, eventId, {
        title: 'Bad zone',
        allDay: false,
        timezone: 'Local/Somewhere',
        startLocal: '2026-08-10T10:00:00',
        endLocal: '2026-08-10T11:00:00',
      })
    ).toBeNull();
  });

  it('skips absent month days and preserves January 31 afterwards', () => {
    const event = mutation(uuid('3'), '2026-01-31T10:00:00', {
      frequency: 'monthly',
      untilLocalDate: '2026-04-30',
    });
    const occurrences = expandReticulumCalendarMutation(
      event,
      Date.parse('2026-01-01T00:00:00Z'),
      Date.parse('2026-05-01T00:00:00Z')
    );
    expect(occurrences.map((item) => item.startLocal.slice(0, 10))).toEqual([
      '2026-01-31',
      '2026-01-31',
    ]);
    expect(
      occurrences.map((item) =>
        new Date(item.occurrenceStart).toLocaleDateString('en-CA', {
          timeZone: 'Europe/Bucharest',
        })
      )
    ).toEqual(['2026-01-31', '2026-03-31']);
  });

  it('keeps leap-day yearly events on leap years only', () => {
    const event = mutation(uuid('4'), '2024-02-29T10:00:00', {
      frequency: 'yearly',
      untilLocalDate: '2030-12-31',
    });
    const occurrences = expandReticulumCalendarMutation(
      event,
      Date.parse('2024-01-01T00:00:00Z'),
      Date.parse('2031-01-01T00:00:00Z')
    );
    expect(
      occurrences.map((item) =>
        new Date(item.occurrenceStart).toLocaleDateString('en-CA', {
          timeZone: 'Europe/Bucharest',
        })
      )
    ).toEqual(['2024-02-29', '2028-02-29']);
  });

  it('finds the next leap-day reminder without expanding intervening years', () => {
    const event = mutation(uuid('5'), '2024-02-29T10:00:00', {
      frequency: 'yearly',
    });
    const occurrence = findNextReticulumCalendarOccurrence(
      event,
      moment.tz('2025-03-01T00:00:00', 'Europe/Bucharest').valueOf()
    );
    expect(
      moment(occurrence?.occurrenceStart)
        .tz('Europe/Bucharest')
        .format('YYYY-MM-DDTHH:mm')
    ).toBe('2028-02-29T10:00');
  });

  it('expands monthly recurrences correctly years after the series began', () => {
    const event = mutation(uuid('8'), '2020-01-31T10:00:00', {
      frequency: 'monthly',
    });
    const occurrences = expandReticulumCalendarMutation(
      event,
      moment.tz('2030-03-01T00:00:00', 'Europe/Bucharest').valueOf(),
      moment.tz('2030-04-01T00:00:00', 'Europe/Bucharest').valueOf()
    );
    expect(occurrences).toHaveLength(1);
    expect(
      moment(occurrences[0].occurrenceStart)
        .tz('Europe/Bucharest')
        .format('YYYY-MM-DDTHH:mm')
    ).toBe('2030-03-31T10:00');
  });

  it('advances recurring reminders past an already-fired occurrence', () => {
    const event = mutation(uuid('6'), '2026-08-01T10:00:00', {
      frequency: 'daily',
    });
    const first = findNextReticulumCalendarOccurrence(
      event,
      moment.tz('2026-08-01T09:00:00', 'Europe/Bucharest').valueOf()
    );
    const next = findNextReticulumCalendarOccurrence(
      event,
      Number(first?.occurrenceStart) + 1
    );
    expect(
      moment(next?.occurrenceStart)
        .tz('Europe/Bucharest')
        .format('YYYY-MM-DDTHH:mm')
    ).toBe('2026-08-02T10:00');
  });

  it('preserves recurring wall-clock times across daylight-saving changes', () => {
    const event = mutation(uuid('7'), '2026-03-22T10:00:00', {
      frequency: 'weekly',
      untilLocalDate: '2026-04-12',
    });
    const occurrences = expandReticulumCalendarMutation(
      event,
      Date.parse('2026-03-20T00:00:00Z'),
      Date.parse('2026-04-15T00:00:00Z')
    );
    expect(
      occurrences.map((item) => [
        moment(item.occurrenceStart).tz('Europe/Bucharest').format('HH:mm'),
        moment(item.occurrenceEnd).tz('Europe/Bucharest').format('HH:mm'),
      ])
    ).toEqual([
      ['10:00', '11:00'],
      ['10:00', '11:00'],
      ['10:00', '11:00'],
      ['10:00', '11:00'],
    ]);
  });

  it('batches snapshot projections and keeps recurring events in a capped range', () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'reticulum-calendar-test-')
    );
    const db = new ReticulumChatDatabase(path.join(root, 'calendar.db'));
    try {
      const oneTime = mutation(uuid('10'), '2026-08-15T10:00:00', null);
      const recurring = mutation(uuid('11'), '2026-08-01T10:00:00', {
        frequency: 'daily',
        untilLocalDate: '2026-08-20',
      });
      recurring.mutationId = uuid('12');
      const results = db.upsertCalendarMutations([
        { mutation: oneTime, resourceHash: 'a'.repeat(64) },
        { mutation: recurring, resourceHash: 'b'.repeat(64) },
      ]);
      expect(results).toEqual([
        { inserted: true, projected: true },
        { inserted: true, projected: true },
      ]);
      const occurrences = db.getCalendarOccurrences(
        1144,
        moment.tz('2026-08-10T00:00:00', 'Europe/Bucharest').valueOf(),
        moment.tz('2026-08-16T00:00:00', 'Europe/Bucharest').valueOf(),
        1
      );
      expect(occurrences).toHaveLength(1);
      expect(occurrences[0].eventId).toBe(recurring.eventId);
      expect(
        moment(occurrences[0].occurrenceStart)
          .tz('Europe/Bucharest')
          .format('YYYY-MM-DDTHH:mm')
      ).toBe('2026-08-10T10:00');
    } finally {
      db.close();
      fs.rmSync(root, { force: true, recursive: true });
    }
  });
});
