import { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  Box,
  Button,
  ButtonBase,
  CircularProgress,
  Skeleton,
  Tooltip,
  Typography,
  useTheme,
} from '@mui/material';
import AccessTimeRoundedIcon from '@mui/icons-material/AccessTimeRounded';
import EventRoundedIcon from '@mui/icons-material/EventRounded';
import LocationOnRoundedIcon from '@mui/icons-material/LocationOnRounded';
import { useAtom, useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import i18n from '../../i18n/i18n';
import { QORTAL_APP_CONTEXT } from '../../App';
import {
  memberGroupsAtom,
  memberGroupsLoadedAddressAtom,
  txListAtom,
  userInfoAtom,
} from '../../atoms/global';
import { getFee } from '../../background/background';
import { executeEvent } from '../../utils/events';
import { parseQortalUseGroupLink } from '../../utils/qortalGroupLinks';
import { getReticulumGroupMetadata } from '../Group/ReticulumGroupAbout';

const EVENT_LINK_PATTERN =
  /qortal:\/\/(?:APP\/Q-Chat\/calendar\?[^\s<>"']+|use-group\/action-calendar\/[^\s<>"']+)/gi;
const EVENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENT_PREVIEW_ACCENT = '#9b63f5';
const EVENT_PREVIEW_CACHE_TTL_MS = 2 * 60 * 1000;
const EVENT_PREVIEW_FAILURE_TTL_MS = 2 * 60 * 1000;
const EVENT_PREVIEW_CACHE_MAX_ENTRIES = 48;

export type ReticulumEventLink = {
  eventId: string;
  groupId: number;
  link: string;
  occurrenceStart?: number;
  timezone?: string;
};

type EventPreviewData = {
  groupName: string;
  occurrence: ReticulumCalendarOccurrence;
};

const eventPreviewCache = new Map<
  string,
  { data: EventPreviewData; fetchedAt: number }
>();
const eventPreviewInflight = new Map<string, Promise<EventPreviewData>>();
const eventPreviewFailureCache = new Map<string, number>();
const coverUrlCache = new Map<string, string>();

const stripTrailingLinkPunctuation = (value: string) =>
  value.replace(/[),.;!?]+$/g, '');

const eventLinkCandidateStrings = (source: string) => {
  if (!source) return [];
  if (typeof DOMParser === 'undefined') return [source];
  const documentNode = new DOMParser().parseFromString(source, 'text/html');
  documentNode.querySelectorAll('code, pre').forEach((node) => node.remove());
  const walker = documentNode.createTreeWalker(
    documentNode.body,
    NodeFilter.SHOW_TEXT
  );
  const text: string[] = [];
  let node = walker.nextNode();
  while (node) {
    text.push(node.textContent || '');
    node = walker.nextNode();
  }
  const hrefs = Array.from(documentNode.querySelectorAll('a[href]'))
    .map((anchor) => anchor.getAttribute('href') || '')
    .filter(Boolean);
  return [text.join(' '), ...hrefs];
};

const collectEventLinkCandidateStrings = (source: unknown) => {
  const output: string[] = [];
  const pending: Array<{ depth: number; value: unknown }> = [
    { depth: 0, value: source },
  ];
  const seen = new WeakSet<object>();
  let visited = 0;
  let collectedCharacters = 0;
  while (pending.length && visited < 256 && collectedCharacters < 128_000) {
    const current = pending.shift()!;
    visited += 1;
    if (typeof current.value === 'string') {
      for (const candidate of eventLinkCandidateStrings(current.value)) {
        if (!candidate) continue;
        output.push(candidate);
        collectedCharacters += candidate.length;
        if (collectedCharacters >= 128_000) break;
      }
      continue;
    }
    if (
      current.depth >= 12 ||
      current.value == null ||
      typeof current.value !== 'object'
    ) {
      continue;
    }
    const objectValue = current.value as object;
    if (seen.has(objectValue)) continue;
    seen.add(objectValue);
    const children = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value as Record<string, unknown>);
    for (const child of children) {
      pending.push({ depth: current.depth + 1, value: child });
    }
  }
  return output;
};

const parseCandidate = (candidate: string): ReticulumEventLink | null => {
  const link = stripTrailingLinkPunctuation(candidate);
  const groupAction = parseQortalUseGroupLink(link);
  if (groupAction?.action === 'calendar') {
    return {
      eventId: groupAction.eventId,
      groupId: groupAction.groupId,
      link,
    };
  }
  // Chromium treats unknown schemes such as qortal:// as non-special URLs and
  // reports "//APP/Q-Chat/calendar" as the pathname with an empty hostname,
  // while Node reports APP as the hostname. Parse the canonical Qortal route
  // directly so previews behave identically in tests and in Electron.
  const routeMatch = link.match(/^qortal:\/\/APP\/Q-Chat\/calendar\?([^#]+)$/i);
  if (!routeMatch) return null;
  const searchParams = new URLSearchParams(routeMatch[1]);
  const groupId = Number(searchParams.get('groupId'));
  const eventId = String(searchParams.get('eventId') || '')
    .trim()
    .toLowerCase();
  const occurrenceStartValue = searchParams.get('occurrenceStart');
  const occurrenceStart = occurrenceStartValue
    ? Number(occurrenceStartValue)
    : undefined;
  const timezone = String(searchParams.get('timezone') || '').trim();
  if (
    !Number.isInteger(groupId) ||
    groupId <= 0 ||
    !EVENT_ID_PATTERN.test(eventId) ||
    (occurrenceStart !== undefined &&
      (!Number.isFinite(occurrenceStart) || occurrenceStart <= 0)) ||
    timezone.length > 100
  ) {
    return null;
  }
  return {
    eventId,
    groupId,
    link,
    ...(occurrenceStart !== undefined ? { occurrenceStart } : {}),
    ...(timezone ? { timezone } : {}),
  };
};

export const parseReticulumEventLinks = (
  source: unknown
): ReticulumEventLink[] => {
  const candidates = collectEventLinkCandidateStrings(source).flatMap(
    (candidate) => candidate.match(EVENT_LINK_PATTERN) || []
  );
  const seen = new Set<string>();
  const output: ReticulumEventLink[] = [];
  for (const candidate of candidates) {
    const parsed = parseCandidate(candidate);
    if (!parsed) continue;
    const key = parsed.link.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(parsed);
    // Event embeds are deliberately large. One per message avoids oversized
    // messages and bounds calendar/resource work during history rendering.
    break;
  }
  return output;
};

const previewKey = (link: ReticulumEventLink) =>
  `${link.groupId}:${link.eventId}:${link.occurrenceStart ?? 'series'}`;

const readCachedPreview = (key: string) => {
  const cached = eventPreviewCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.fetchedAt > EVENT_PREVIEW_CACHE_TTL_MS) {
    eventPreviewCache.delete(key);
    return null;
  }
  eventPreviewCache.delete(key);
  eventPreviewCache.set(key, cached);
  return cached.data;
};

const writeCachedPreview = (key: string, data: EventPreviewData) => {
  eventPreviewFailureCache.delete(key);
  eventPreviewCache.delete(key);
  eventPreviewCache.set(key, { data, fetchedAt: Date.now() });
  while (eventPreviewCache.size > EVENT_PREVIEW_CACHE_MAX_ENTRIES) {
    const oldest = eventPreviewCache.keys().next().value as string | undefined;
    if (!oldest) break;
    eventPreviewCache.delete(oldest);
  }
};

const hasCachedPreviewFailure = (key: string) => {
  const failedAt = eventPreviewFailureCache.get(key);
  if (!failedAt) return false;
  if (Date.now() - failedAt <= EVENT_PREVIEW_FAILURE_TTL_MS) return true;
  eventPreviewFailureCache.delete(key);
  return false;
};

const loadEventPreview = async (
  link: ReticulumEventLink,
  force = false
): Promise<EventPreviewData> => {
  const key = previewKey(link);
  if (!force) {
    const cached = readCachedPreview(key);
    if (cached) return cached;
    if (hasCachedPreviewFailure(key)) {
      throw new Error(
        i18n.t('group:reticulum.event_preview.unavailable_temporarily', {
          postProcess: 'capitalizeFirstChar',
        })
      );
    }
    const inflight = eventPreviewInflight.get(key);
    if (inflight) return inflight;
  } else {
    eventPreviewFailureCache.delete(key);
  }
  const request = (async () => {
    if (!window.reticulumChat?.getCalendarEvent) {
      throw new Error(
        i18n.t('group:reticulum.event_preview.calendar_unavailable', {
          postProcess: 'capitalizeFirstChar',
        })
      );
    }
    const occurrence = await window.reticulumChat.getCalendarEvent(
      link.groupId,
      link.eventId,
      link.occurrenceStart
    );
    if (!occurrence)
      throw new Error(
        i18n.t('group:reticulum.event_preview.not_found', {
          postProcess: 'capitalizeFirstChar',
        })
      );
    const group = await getReticulumGroupMetadata(link.groupId).catch(
      () => null
    );
    const groupName = String(
      group?.groupName || group?.name || `Group ${link.groupId}`
    ).trim();
    const data = { groupName, occurrence };
    writeCachedPreview(key, data);
    return data;
  })()
    .catch((error) => {
      eventPreviewFailureCache.set(key, Date.now());
      throw error;
    })
    .finally(() => eventPreviewInflight.delete(key));
  eventPreviewInflight.set(key, request);
  return request;
};

const openEvent = (
  link: ReticulumEventLink,
  occurrence?: ReticulumCalendarOccurrence | null
) => {
  executeEvent('openGroupMessage', {
    eventId: link.eventId,
    from: link.groupId,
    occurrenceStart:
      occurrence?.occurrenceStart ?? link.occurrenceStart ?? Date.now(),
    openCalendar: true,
    timezone: occurrence?.timezone ?? link.timezone ?? '',
  });
};

const isOpenGroup = (group: any) =>
  group?.isOpen === true ||
  group?.groupType === 0 ||
  group?.groupType === 'OPEN';

const openGroupOverview = (group: any) => {
  executeEvent('openFindGroupOverview', { group });
};

const formatTime = (timestamp: number, locale: string) =>
  new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    hour12: false,
    minute: '2-digit',
  }).format(timestamp);

const formatTimeRange = (
  occurrence: ReticulumCalendarOccurrence,
  locale: string,
  allDayLabel: string
) => {
  if (occurrence.allDay) return allDayLabel;
  return `${formatTime(occurrence.occurrenceStart, locale)} – ${formatTime(
    occurrence.occurrenceEnd,
    locale
  )}`;
};

function useCoverUrl(occurrence: ReticulumCalendarOccurrence | null) {
  const cover = occurrence?.coverImage;
  const [url, setUrl] = useState(() =>
    cover?.fileHash ? coverUrlCache.get(cover.fileHash) || '' : ''
  );

  useEffect(() => {
    setUrl(cover?.fileHash ? coverUrlCache.get(cover.fileHash) || '' : '');
    if (!occurrence || !cover?.fileHash) return;
    let cancelled = false;
    const timers: number[] = [];
    const load = async (attempt = 0) => {
      const local = await window.reticulumResources
        ?.getUrl?.(cover.fileHash)
        .catch(() => null);
      if (cancelled) return;
      if (local?.success && local.url) {
        coverUrlCache.set(cover.fileHash, local.url);
        setUrl(local.url);
        return;
      }
      if (attempt === 0) {
        await window.reticulumChat
          ?.requestResource?.(occurrence.groupId, cover, occurrence.eventId)
          .catch(() => null);
      }
      if (attempt < 5) {
        timers.push(
          window.setTimeout(
            () => void load(attempt + 1),
            attempt === 0 ? 900 : Math.min(5_000, attempt * 1_250)
          )
        );
      }
    };
    void load();
    return () => {
      cancelled = true;
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [cover, occurrence]);

  return url;
}

const clampLines = (lines: number) => ({
  WebkitBoxOrient: 'vertical' as const,
  WebkitLineClamp: lines,
  display: '-webkit-box',
  overflow: 'hidden',
});

function EventPreviewCard({
  data,
  link,
}: {
  data: EventPreviewData;
  link: ReticulumEventLink;
}) {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const { occurrence } = data;
  const coverUrl = useCoverUrl(occurrence);
  const start = occurrence.occurrenceStart;
  const location = occurrence.location.trim() || data.groupName;
  const allDayLabel = t('core:calendar.allDay');
  const timeRange = formatTimeRange(occurrence, i18n.language, allDayLabel);
  const month = new Intl.DateTimeFormat(i18n.language, {
    month: 'short',
  })
    .format(start)
    .replace('.', '')
    .toUpperCase();
  const day = new Intl.DateTimeFormat(i18n.language, { day: 'numeric' }).format(
    start
  );
  const weekday = new Intl.DateTimeFormat(i18n.language, {
    weekday: 'short',
  })
    .format(start)
    .replace('.', '')
    .toUpperCase();
  const date = new Intl.DateTimeFormat(i18n.language, {
    day: 'numeric',
    month: 'long',
    weekday: 'long',
    year: 'numeric',
  }).format(start);
  const description = occurrence.description.trim();
  const dark = theme.palette.mode === 'dark';

  return (
    <ButtonBase
      aria-label={t('calendar.openEvent', 'Open event {{title}}', {
        title: occurrence.title,
      })}
      onClick={(event) => {
        event.stopPropagation();
        openEvent(link, occurrence);
      }}
      sx={{
        borderRadius: '10px',
        display: 'block',
        maxWidth: 'min(760px, 100%)',
        mt: 0.8,
        textAlign: 'left',
        width: '100%',
      }}
    >
      <Box
        sx={{
          background: dark
            ? 'linear-gradient(135deg, rgba(22,27,35,0.96), rgba(16,20,27,0.98))'
            : theme.palette.background.paper,
          border: `1px solid ${
            dark ? 'rgba(155,169,192,0.24)' : 'rgba(50,64,84,0.2)'
          }`,
          borderLeft: `4px solid ${EVENT_PREVIEW_ACCENT}`,
          borderRadius: '10px',
          boxShadow: dark
            ? '0 12px 34px rgba(0,0,0,0.2), inset 0 1px 0 rgba(255,255,255,0.025)'
            : '0 12px 30px rgba(35,47,65,0.1)',
          boxSizing: 'border-box',
          color: 'text.primary',
          overflow: 'hidden',
          p: 2.25,
          transition: 'border-color 0.18s ease, transform 0.18s ease',
          width: '100%',
          '&:hover': {
            borderColor: dark
              ? 'rgba(174,188,212,0.38)'
              : 'rgba(50,64,84,0.34)',
          },
        }}
      >
        <Box
          sx={{
            alignItems: 'center',
            color: 'text.secondary',
            display: 'flex',
            gap: 0.65,
            justifyContent: 'flex-start',
            minHeight: 24,
            pb: 1.5,
          }}
        >
          <EventRoundedIcon
            sx={{ color: EVENT_PREVIEW_ACCENT, fontSize: 20 }}
          />
          <Typography fontSize={12} fontWeight={650}>
            {'Q-Chat\u00a0\u00a0·\u00a0\u00a0Event'}
          </Typography>
        </Box>

        <Box
          sx={{
            display: 'grid',
            gap: { xs: 2, sm: 3 },
            gridTemplateColumns: {
              xs: 'minmax(0, 1fr)',
              sm: 'minmax(0, 1.04fr) minmax(0, 1fr)',
            },
          }}
        >
          <Box
            sx={{
              alignSelf: 'start',
              border: `1px solid ${
                dark ? 'rgba(155,169,192,0.3)' : 'rgba(50,64,84,0.22)'
              }`,
              borderRadius: '8px',
              minWidth: 0,
              overflow: 'hidden',
              width: '100%',
            }}
          >
            <Box
              sx={{
                aspectRatio: '16 / 9',
                background: coverUrl
                  ? '#0c1017'
                  : dark
                    ? 'radial-gradient(circle at 48% 45%, rgba(155,99,245,0.3), transparent 42%), linear-gradient(145deg, #171b27, #0d1118)'
                    : 'radial-gradient(circle at 48% 45%, rgba(155,99,245,0.13), transparent 42%), linear-gradient(145deg, #ffffff, #f7f3e9)',
                overflow: 'hidden',
                position: 'relative',
              }}
            >
              {coverUrl ? (
                <Box
                  alt=""
                  component="img"
                  src={coverUrl}
                  sx={{
                    display: 'block',
                    height: '100%',
                    objectFit: 'cover',
                    width: '100%',
                  }}
                />
              ) : (
                <EventRoundedIcon
                  sx={{
                    color: dark
                      ? 'rgba(155,99,245,0.4)'
                      : 'rgba(116,78,184,0.55)',
                    fontSize: 72,
                    left: '50%',
                    position: 'absolute',
                    top: '50%',
                    transform: 'translate(-50%, -50%)',
                  }}
                />
              )}
              <Box
                sx={{
                  backdropFilter: 'blur(10px)',
                  backgroundColor: 'rgba(7,10,17,0.58)',
                  border: '1px solid rgba(177,187,209,0.25)',
                  borderRadius: '8px',
                  boxShadow: '0 8px 22px rgba(0,0,0,0.3)',
                  color: '#f4f2f8',
                  left: 12,
                  minWidth: 72,
                  px: 1.25,
                  py: 0.9,
                  position: 'absolute',
                  textAlign: 'center',
                  top: 12,
                }}
              >
                <Typography
                  sx={{
                    color: EVENT_PREVIEW_ACCENT,
                    fontSize: 14,
                    fontWeight: 750,
                    lineHeight: 1.1,
                  }}
                >
                  {month}
                </Typography>
                <Typography
                  sx={{ fontSize: 27, fontWeight: 800, lineHeight: 1.08 }}
                >
                  {day}
                </Typography>
                <Typography
                  sx={{
                    color: 'rgba(244,242,248,0.76)',
                    fontSize: 11,
                    fontWeight: 500,
                    lineHeight: 1.25,
                  }}
                >
                  {weekday}
                </Typography>
              </Box>
            </Box>
            <Box
              sx={{
                alignItems: 'center',
                background: dark
                  ? 'linear-gradient(100deg, rgba(91,59,135,0.98), rgba(73,49,111,0.98))'
                  : 'linear-gradient(100deg, rgba(128,102,173,0.96), rgba(110,87,152,0.96))',
                borderRadius: '0 0 7px 7px',
                color: '#ffffff',
                display: 'flex',
                gap: 0.8,
                height: 48,
                px: 1.4,
              }}
            >
              <AccessTimeRoundedIcon sx={{ fontSize: 20 }} />
              <Typography
                noWrap
                sx={{ flex: 1, fontSize: 14, fontWeight: 700 }}
              >
                {timeRange}
              </Typography>
              <LocationOnRoundedIcon sx={{ fontSize: 21 }} />
            </Box>
          </Box>

          <Box
            sx={{
              display: 'flex',
              flexDirection: 'column',
              minHeight: { sm: 252 },
              minWidth: 0,
              pr: { sm: 0.5 },
              py: { sm: 0.45 },
            }}
          >
            <Tooltip arrow placement="top" title={occurrence.title}>
              <Typography
                noWrap
                sx={{
                  color: dark ? '#f2f4f7' : '#20242c',
                  fontSize: 19,
                  fontWeight: 750,
                  lineHeight: 1.3,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {occurrence.title}
              </Typography>
            </Tooltip>

            {description ? (
              <Tooltip arrow placement="top" title={description}>
                <Typography
                  sx={{
                    ...clampLines(4),
                    color: 'text.secondary',
                    fontSize: 14.5,
                    lineHeight: 1.5,
                    mt: 0.9,
                    overflowWrap: 'anywhere',
                  }}
                >
                  {description}
                </Typography>
              </Tooltip>
            ) : null}

            <Box
              sx={{
                alignItems: 'center',
                display: 'flex',
                gap: 0.9,
                mt: description ? 1.65 : 1.5,
                minWidth: 0,
              }}
            >
              <LocationOnRoundedIcon
                sx={{
                  color: EVENT_PREVIEW_ACCENT,
                  flexShrink: 0,
                  fontSize: 21,
                }}
              />
              <Tooltip arrow placement="top" title={location}>
                <Typography
                  noWrap
                  sx={{
                    fontSize: 13.5,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {location}
                </Typography>
              </Tooltip>
            </Box>

            <Box
              sx={{
                alignItems: 'flex-start',
                display: 'flex',
                gap: 0.9,
                mt: 1.25,
              }}
            >
              <AccessTimeRoundedIcon
                sx={{
                  color: EVENT_PREVIEW_ACCENT,
                  flexShrink: 0,
                  fontSize: 21,
                }}
              />
              <Box sx={{ minWidth: 0 }}>
                <Typography
                  sx={{
                    color: dark ? '#eceff4' : '#2b3039',
                    fontSize: 13.5,
                    fontWeight: 550,
                    lineHeight: 1.3,
                  }}
                >
                  {date}
                </Typography>
                <Typography
                  sx={{ color: 'text.secondary', fontSize: 13, mt: 0.25 }}
                >
                  {timeRange}
                  {!occurrence.allDay
                    ? ` (${t('core:calendar.yourTime')})`
                    : ''}
                </Typography>
              </Box>
            </Box>
          </Box>
        </Box>
      </Box>
    </ButtonBase>
  );
}

function EventUnavailableCard({
  group,
  groupId,
}: {
  group: any;
  groupId: number;
}) {
  const theme = useTheme();
  const { show } = useContext(QORTAL_APP_CONTEXT);
  const { t } = useTranslation();
  const userInfo = useAtomValue(userInfoAtom);
  const [txList, setTxList] = useAtom(txListAtom);
  const [isJoining, setIsJoining] = useState(false);
  const [joinError, setJoinError] = useState('');
  const openGroup = isOpenGroup(group);
  const groupName = String(
    group?.groupName || group?.name || `Group ${groupId}`
  ).trim();
  const pending = (txList || []).some(
    (transaction: any) =>
      (transaction?.type === 'joined-group' ||
        transaction?.type === 'joined-group-request') &&
      transaction?.done !== true &&
      String(transaction?.groupId) === String(groupId)
  );

  const join = useCallback(async () => {
    if (isJoining || pending) return;
    setJoinError('');
    setIsJoining(true);
    try {
      const fee = await getFee('JOIN_GROUP');
      await show({
        message: openGroup
          ? t('core:calendar.joinSourceGroupQuestion')
          : t('core:calendar.requestSourceGroupQuestion'),
        publishFee: `${fee.fee} QORT`,
      });
      const response = await window.sendMessage('joinGroup', { groupId });
      if (response?.error) throw new Error(response.error);
      setTxList((current: any[]) => [
        {
          ...response,
          done: false,
          groupId,
          label: openGroup
            ? `Joining ${groupName}`
            : `Requesting to join ${groupName}`,
          labelDone: openGroup
            ? `Joined ${groupName}`
            : `Request sent to ${groupName}`,
          memberAddress: openGroup ? userInfo?.address : undefined,
          type: openGroup ? 'joined-group' : 'joined-group-request',
        },
        ...current,
      ]);
    } catch (error: any) {
      if (!error?.isCanceled) {
        setJoinError(error?.message || t('core:calendar.sourceGroupJoinError'));
      }
    } finally {
      setIsJoining(false);
    }
  }, [
    groupId,
    groupName,
    isJoining,
    openGroup,
    pending,
    setTxList,
    show,
    t,
    userInfo?.address,
  ]);

  return (
    <Box
      sx={{
        background:
          theme.palette.mode === 'dark'
            ? 'linear-gradient(135deg, rgba(22,27,35,0.96), rgba(16,20,27,0.98))'
            : theme.palette.background.paper,
        border: '1px solid',
        borderColor: 'divider',
        borderLeft: `4px solid ${EVENT_PREVIEW_ACCENT}`,
        borderRadius: '10px',
        boxSizing: 'border-box',
        maxWidth: 'min(760px, 100%)',
        mt: 0.8,
        p: 2,
        width: '100%',
      }}
    >
      <Box sx={{ alignItems: 'center', display: 'flex', gap: 0.7, mb: 1.35 }}>
        <EventRoundedIcon sx={{ color: EVENT_PREVIEW_ACCENT, fontSize: 20 }} />
        <Typography color="text.secondary" fontSize={12} fontWeight={650}>
          {'Q-Chat\u00a0\u00a0·\u00a0\u00a0Event'}
        </Typography>
      </Box>
      <Typography sx={{ fontSize: 16, fontWeight: 700 }}>
        {t('core:calendar.eventUnavailable')}
      </Typography>
      <Typography
        sx={{
          color: 'text.secondary',
          fontSize: 13.5,
          lineHeight: 1.5,
          mt: 0.35,
        }}
      >
        {t('core:calendar.eventRequiresSourceMembership')}
      </Typography>
      {joinError ? (
        <Typography
          role="alert"
          sx={{ color: 'error.main', fontSize: 12.5, mt: 1.15 }}
        >
          {joinError}
        </Typography>
      ) : null}
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 1.6 }}>
        <Button
          onClick={(event) => {
            event.stopPropagation();
            openGroupOverview(group);
          }}
          sx={{
            backgroundColor:
              theme.palette.mode === 'dark' ? '#262b34' : '#e8ebf0',
            border: '1px solid',
            borderColor: 'divider',
            borderRadius: '8px',
            color: 'text.primary',
            fontSize: 13,
            fontWeight: 650,
            minHeight: 38,
            px: 1.75,
            textTransform: 'none',
            '&:hover': {
              backgroundColor:
                theme.palette.mode === 'dark' ? '#303640' : '#dfe3e9',
              borderColor: 'divider',
            },
          }}
        >
          {t('core:calendar.viewGroup')}
        </Button>
        <Button
          disabled={isJoining || pending}
          onClick={(event) => {
            event.stopPropagation();
            void join();
          }}
          sx={{
            backgroundColor: '#2f6feb',
            border: '1px solid #2f6feb',
            borderRadius: '8px',
            color: '#ffffff',
            fontSize: 13,
            fontWeight: 650,
            minHeight: 38,
            minWidth: 84,
            px: 1.75,
            textTransform: 'none',
            '&:hover': {
              backgroundColor: '#3b7cf4',
              borderColor: '#3b7cf4',
            },
            '&.Mui-disabled': {
              backgroundColor: '#2f6feb',
              borderColor: '#2f6feb',
              color: '#ffffff',
              opacity: 0.55,
            },
          }}
        >
          {isJoining ? (
            <CircularProgress color="inherit" size={17} />
          ) : pending ? (
            t('core:calendar.pending')
          ) : openGroup ? (
            t('core:action.join', 'Join')
          ) : (
            t('core:calendar.request')
          )}
        </Button>
      </Box>
    </Box>
  );
}

function EventPreview({ link }: { link: ReticulumEventLink }) {
  const memberGroups = useAtomValue(memberGroupsAtom);
  const memberGroupsLoadedAddress = useAtomValue(memberGroupsLoadedAddressAtom);
  const userInfo = useAtomValue(userInfoAtom);
  const key = previewKey(link);
  const [data, setData] = useState<EventPreviewData | null>(() =>
    readCachedPreview(key)
  );
  const [failed, setFailed] = useState(() => hasCachedPreviewFailure(key));
  const [group, setGroup] = useState<any>(null);
  const [groupLoadFinished, setGroupLoadFinished] = useState(false);
  const membershipResolved = Boolean(
    userInfo?.address && memberGroupsLoadedAddress === userInfo.address
  );
  const isMember = useMemo(
    () =>
      (memberGroups || []).some(
        (entry: any) => String(entry?.groupId) === String(link.groupId)
      ),
    [link.groupId, memberGroups]
  );

  useEffect(() => {
    if (!membershipResolved || isMember) {
      setGroup(null);
      setGroupLoadFinished(false);
      return undefined;
    }
    let active = true;
    setGroupLoadFinished(false);
    void getReticulumGroupMetadata(link.groupId)
      .then((next) => {
        if (active) setGroup(next);
      })
      .finally(() => {
        if (active) setGroupLoadFinished(true);
      });
    return () => {
      active = false;
    };
  }, [isMember, link.groupId, membershipResolved]);

  const load = useCallback(
    async (force = false) => {
      setFailed(false);
      try {
        setData(await loadEventPreview(link, force));
      } catch {
        setFailed(true);
      }
    },
    [link]
  );

  useEffect(() => {
    if (membershipResolved && isMember && !data && !failed) void load();
  }, [data, failed, isMember, load, membershipResolved]);

  useEffect(
    () =>
      window.reticulumChat?.onCalendarChanged?.((payload) => {
        if (
          payload.groupId === link.groupId &&
          (!payload.eventId || payload.eventId === link.eventId)
        ) {
          eventPreviewCache.delete(key);
          eventPreviewFailureCache.delete(key);
          setFailed(false);
          if (membershipResolved && isMember) void load(true);
        }
      }),
    [isMember, key, link.eventId, link.groupId, load, membershipResolved]
  );

  if (!membershipResolved || (!isMember && (!groupLoadFinished || !group))) {
    return (
      <Box
        aria-label={t('group:reticulum.event_preview.loading', {
          postProcess: 'capitalizeFirstChar',
        })}
        sx={{
          border: '1px solid',
          borderColor: 'divider',
          borderLeft: `4px solid ${EVENT_PREVIEW_ACCENT}`,
          borderRadius: '10px',
          boxSizing: 'border-box',
          maxWidth: 'min(760px, 100%)',
          minHeight: 112,
          mt: 0.8,
          p: 1.75,
          width: '100%',
        }}
      >
        <Skeleton height={22} width={160} />
        <Skeleton height={18} width="68%" />
        <Skeleton height={30} sx={{ mt: 0.75 }} width={190} />
      </Box>
    );
  }

  if (!isMember) {
    return <EventUnavailableCard group={group} groupId={link.groupId} />;
  }

  if (failed) {
    return (
      <ButtonBase
        onClick={() => openEvent(link)}
        sx={{
          border: '1px solid',
          borderColor: 'divider',
          borderLeft: `4px solid ${EVENT_PREVIEW_ACCENT}`,
          borderRadius: '8px',
          display: 'block',
          maxWidth: 'min(760px, 100%)',
          mt: 0.8,
          p: 1.5,
          textAlign: 'left',
          width: '100%',
        }}
      >
        <Typography fontSize={13.5} fontWeight={700}>
          Event preview unavailable
        </Typography>
        <Typography color="text.secondary" fontSize={12.5}>
          Open the event to view its latest details.
        </Typography>
      </ButtonBase>
    );
  }

  if (!data) {
    return (
      <Box
        sx={{
          border: '1px solid',
          borderColor: 'divider',
          borderLeft: `4px solid ${EVENT_PREVIEW_ACCENT}`,
          borderRadius: '10px',
          boxSizing: 'border-box',
          maxWidth: 'min(760px, 100%)',
          mt: 0.8,
          p: 2.25,
          width: '100%',
        }}
      >
        <Box
          sx={{
            alignItems: 'center',
            display: 'flex',
            minHeight: 24,
            pb: 1.5,
          }}
        >
          <Skeleton height={20} width={120} />
        </Box>
        <Box
          sx={{
            display: 'grid',
            gap: { xs: 2, sm: 3 },
            gridTemplateColumns: { xs: '1fr', sm: '1.04fr 1fr' },
          }}
        >
          <Box>
            <Skeleton sx={{ aspectRatio: '16 / 9', borderRadius: 1 }} />
            <Skeleton height={48} sx={{ mt: '-2px' }} variant="rectangular" />
          </Box>
          <Box sx={{ minHeight: { sm: 252 } }}>
            <Skeleton height={28} width="78%" />
            <Skeleton height={18} width="96%" />
            <Skeleton height={18} width="88%" />
            <Skeleton height={20} sx={{ mt: 2 }} width="70%" />
          </Box>
        </Box>
      </Box>
    );
  }

  return <EventPreviewCard data={data} link={link} />;
}

export function ReticulumEventLinkPreviews({ source }: { source: unknown }) {
  const links = useMemo(() => parseReticulumEventLinks(source), [source]);
  if (links.length === 0) return null;
  return (
    <>
      {links.map((link) => (
        <EventPreview key={link.link} link={link} />
      ))}
    </>
  );
}
