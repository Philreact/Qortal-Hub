import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  MenuItem,
  Stack,
  TextField,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import AddRoundedIcon from '@mui/icons-material/AddRounded';
import ChevronLeftRoundedIcon from '@mui/icons-material/ChevronLeftRounded';
import ChevronRightRoundedIcon from '@mui/icons-material/ChevronRightRounded';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded';
import EditRoundedIcon from '@mui/icons-material/EditRounded';
import EventBusyRoundedIcon from '@mui/icons-material/EventBusyRounded';
import EventRoundedIcon from '@mui/icons-material/EventRounded';
import LaunchRoundedIcon from '@mui/icons-material/LaunchRounded';
import ShareRoundedIcon from '@mui/icons-material/ShareRounded';
import { buildQortalGroupCalendarLink } from '../../utils/qortalGroupLinks';
import CheckRoundedIcon from '@mui/icons-material/CheckRounded';
import UploadRoundedIcon from '@mui/icons-material/UploadRounded';
import moment from 'moment-timezone';
import { useTranslation } from 'react-i18next';
import { Confetti } from '../ui/confetti';
import {
  EventCoverCropDialog,
  type EventCoverDraft,
} from './EventCoverCropDialog';

type Props = {
  open: boolean;
  groupId: number;
  ownerAddress: string;
  canManage: boolean;
  members: Array<{ address: string; name: string }>;
  rolesByAddress: Record<string, 'owner' | 'admin'>;
  targetEventId?: string;
  targetOccurrenceStart?: number;
  targetTimezone?: string;
  onClose: () => void;
};

type FormState = ReticulumCalendarEventInput & {
  recurrenceFrequency: '' | 'daily' | 'weekly' | 'monthly' | 'yearly';
  recurrenceUntil: string;
};

const createForm = (event?: ReticulumCalendarOccurrence): FormState => {
  const timezone = event?.timezone || moment.tz.guess() || 'UTC';
  const start = event
    ? event.startLocal
    : moment().add(1, 'hour').startOf('hour').format('YYYY-MM-DDTHH:mm:ss');
  const end = event
    ? event.endLocal
    : moment().add(2, 'hours').startOf('hour').format('YYYY-MM-DDTHH:mm:ss');
  return {
    title: event?.title || '',
    description: (event?.description || '').slice(0, 500),
    location: event?.location || '',
    link: event?.link || '',
    coverImage: event?.coverImage || null,
    allDay: event?.allDay || false,
    timezone,
    startLocal: start,
    endLocal: end,
    recurrence: null,
    recurrenceFrequency: event?.recurrence?.frequency || '',
    recurrenceUntil: event?.recurrence?.untilLocalDate || '',
  };
};

const RETICULUM_ACTIVE_BLUE = '#2563eb';
const RETICULUM_ACTIVE_BLUE_HOVER = '#1e40af';

export function ReticulumGroupCalendarDialog({
  open,
  groupId,
  ownerAddress,
  canManage,
  members,
  rolesByAddress,
  targetEventId = '',
  targetOccurrenceStart = 0,
  targetTimezone = '',
  onClose,
}: Props) {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const narrow = useMediaQuery(theme.breakpoints.down('md'));
  const wizardColors =
    theme.palette.mode === 'dark'
      ? {
          modal: '#1e2027',
          modalGradient:
            'linear-gradient(145deg, rgba(34, 35, 41, 0.45), rgba(27, 28, 34, 0.18))',
          field: '#171a20',
          fieldDisabled: '#1b1e24',
          border: '#3a414d',
          borderHover: '#525a67',
          divider: '#303640',
          heading: '#f1f3f6',
          entered: '#e8ebf0',
          label: '#b9c0cb',
          subtitle: '#929aa7',
          placeholder: '#7f8896',
          disabled: '#69717d',
          focus: '#607ba8',
          focusLabel: '#9bacc7',
          secondaryButton: '#292e37',
          secondaryButtonHover: '#343a45',
        }
      : {
          modal: '#f4f5f7',
          modalGradient:
            'linear-gradient(145deg, rgba(255,255,255,0.72), rgba(235,237,241,0.3))',
          field: '#ffffff',
          fieldDisabled: '#eceef2',
          border: '#c1c7d0',
          borderHover: '#8f98a6',
          divider: '#d6dae1',
          heading: '#20242b',
          entered: '#292e36',
          label: '#505866',
          subtitle: '#667080',
          placeholder: '#7a8493',
          disabled: '#969eaa',
          focus: '#5874a4',
          focusLabel: '#4f668e',
          secondaryButton: '#e4e7ec',
          secondaryButtonHover: '#d8dce3',
        };
  const [month, setMonth] = useState(() => moment().startOf('month'));
  const [selectedDate, setSelectedDate] = useState(() =>
    moment().format('YYYY-MM-DD')
  );
  const [events, setEvents] = useState<ReticulumCalendarOccurrence[]>([]);
  const [selected, setSelected] = useState<ReticulumCalendarOccurrence | null>(
    null
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [editingStep, setEditingStep] = useState(0);
  const [form, setForm] = useState<FormState>(() => createForm());
  const [saving, setSaving] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  const [postSuccessLink, setPostSuccessLink] = useState('');
  const [deleteConfirmationOpen, setDeleteConfirmationOpen] = useState(false);
  const coverInputRef = useRef<HTMLInputElement | null>(null);
  const [coverCropFile, setCoverCropFile] = useState<File | null>(null);
  const [coverDraft, setCoverDraft] = useState<EventCoverDraft | null>(null);
  const [selectedCoverUrl, setSelectedCoverUrl] = useState('');
  const [selectedCoverLoading, setSelectedCoverLoading] = useState(false);
  const formStart = moment.tz(form.startLocal, form.timezone);
  const formEnd = moment.tz(form.endLocal, form.timezone);
  const formStartsInPast = form.allDay
    ? formStart.clone().startOf('day').isBefore(moment().startOf('day'))
    : formStart.isBefore(moment());
  const formTimingValid =
    formStart.isValid() &&
    formEnd.isValid() &&
    formEnd.isAfter(formStart) &&
    !formStartsInPast;
  const formatWizardDateTime = (value: string) =>
    new Intl.DateTimeFormat(i18n.language, {
      day: 'numeric',
      hour: '2-digit',
      hour12: false,
      minute: '2-digit',
      month: 'long',
      year: 'numeric',
    }).format(moment(value).toDate());
  const celebrationConfettiOptions = useMemo(
    () => ({
      colors: ['#8DB8FF', '#A7CAFF', '#D7E6FF', '#FFFFFF'],
      drift: 0,
      gravity: 0.72,
      origin: { x: 0.5, y: 0.92 },
      particleCount: 68,
      scalar: 0.82,
      spread: 84,
      startVelocity: 24,
      ticks: 180,
    }),
    []
  );

  const range = useMemo(() => {
    const start = month.clone().startOf('month').startOf('week');
    const end = month.clone().endOf('month').endOf('week').add(1, 'day');
    return { start: start.valueOf(), end: end.valueOf() };
  }, [month]);

  const load = useCallback(async () => {
    if (!open || !groupId || !window.reticulumChat?.getCalendarEvents) return;
    setLoading(true);
    setError('');
    try {
      const rows = await window.reticulumChat.getCalendarEvents(
        groupId,
        range.start,
        range.end
      );
      setEvents(rows);
      setSelected((current) =>
        current
          ? rows.find((row) => row.occurrenceId === current.occurrenceId) ||
            null
          : null
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, [groupId, open, range.end, range.start]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setSelected(null);
    setEditing(false);
    setDeleteConfirmationOpen(false);
    setError('');
  }, [groupId]);

  useEffect(() => {
    if (open) return;
    setSelected(null);
    setEditing(false);
    setDeleteConfirmationOpen(false);
  }, [open]);

  useEffect(() => {
    if (!open || !targetOccurrenceStart) return;
    const target = targetTimezone
      ? moment(targetOccurrenceStart).tz(targetTimezone)
      : moment(targetOccurrenceStart);
    setMonth(target.clone().startOf('month'));
    setSelectedDate(target.format('YYYY-MM-DD'));
  }, [open, targetOccurrenceStart, targetTimezone]);

  useEffect(() => {
    if (!open || !targetEventId) return;
    const target = events.find((event) => event.eventId === targetEventId);
    if (!target) return;
    setSelected(target);
    setSelectedDate(
      moment(target.occurrenceStart).tz(target.timezone).format('YYYY-MM-DD')
    );
  }, [events, open, targetEventId]);

  useEffect(() => {
    const cover = selected?.coverImage;
    setSelectedCoverUrl('');
    setSelectedCoverLoading(Boolean(selected && cover?.fileHash));
    if (!selected || !cover?.fileHash) return;
    let cancelled = false;
    const timers: number[] = [];
    const loadCover = async (attempt = 0) => {
      const local = await window.reticulumResources
        ?.getUrl?.(cover.fileHash)
        .catch(() => null);
      if (cancelled) return;
      if (local?.success && local.url) {
        setSelectedCoverUrl(local.url);
        setSelectedCoverLoading(false);
        return;
      }
      if (attempt === 0) {
        await window.reticulumChat
          ?.requestResource?.(groupId, cover, selected.eventId)
          .catch(() => null);
      }
      if (attempt < 6) {
        timers.push(
          window.setTimeout(
            () => void loadCover(attempt + 1),
            attempt === 0 ? 1_000 : Math.min(6_000, attempt * 1_500)
          )
        );
      } else {
        setSelectedCoverLoading(false);
      }
    };
    void loadCover();
    return () => {
      cancelled = true;
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [groupId, selected]);

  useEffect(() => {
    if (!open) return;
    return window.reticulumChat?.onCalendarChanged?.((payload) => {
      if (payload.groupId === groupId) void load();
    });
  }, [groupId, load, open]);

  const days = useMemo(() => {
    const cursor = moment(range.start);
    const output: moment.Moment[] = [];
    while (cursor.valueOf() < range.end) {
      output.push(cursor.clone());
      cursor.add(1, 'day');
    }
    return output;
  }, [range.end, range.start]);

  const eventsByDay = useMemo(() => {
    const map = new Map<string, ReticulumCalendarOccurrence[]>();
    for (const event of events) {
      const start = moment(event.occurrenceStart).tz(event.timezone);
      const end = moment(event.occurrenceEnd).tz(event.timezone);
      const finalDay = end.clone().startOf('day');
      // End dates for all-day events, and exact-midnight timed events, are
      // exclusive. This keeps a one-day event on one calendar cell.
      if (end.valueOf() === finalDay.valueOf() && end.isAfter(start)) {
        finalDay.subtract(1, 'day');
      }
      const day = start.clone().startOf('day');
      for (let guard = 0; guard < 367 && !day.isAfter(finalDay); guard += 1) {
        const key = day.format('YYYY-MM-DD');
        const list = map.get(key) || [];
        list.push(event);
        map.set(key, list);
        day.add(1, 'day');
      }
    }
    return map;
  }, [events]);

  const agendaDays = useMemo(() => {
    const start = moment(selectedDate, 'YYYY-MM-DD', true);
    if (!start.isValid()) return [];
    const end = start.clone().endOf('isoWeek');
    const output: Array<{
      key: string;
      date: moment.Moment;
      events: ReticulumCalendarOccurrence[];
    }> = [];
    for (
      const day = start.clone();
      !day.isAfter(end, 'day');
      day.add(1, 'day')
    ) {
      const key = day.format('YYYY-MM-DD');
      output.push({
        key,
        date: day.clone(),
        events: eventsByDay.get(key) || [],
      });
    }
    return output;
  }, [eventsByDay, selectedDate]);
  const selectedAgendaDay = agendaDays[0];
  const upcomingAgendaDays = agendaDays
    .slice(1)
    .filter((day) => day.events.length > 0);
  const visibleAgendaDays = selectedAgendaDay
    ? [selectedAgendaDay, ...upcomingAgendaDays]
    : [];
  const weeklyAgendaEmpty = agendaDays.every((day) => day.events.length === 0);

  const memberNamesByAddress = useMemo(
    () => new Map(members.map((member) => [member.address, member.name])),
    [members]
  );

  const creatorLabel = (address: string) =>
    memberNamesByAddress.get(address) ||
    (address.length > 14
      ? `${address.slice(0, 7)}…${address.slice(-5)}`
      : address);

  const roleColor = (address: string) => {
    const role = rolesByAddress[address];
    if (role === 'owner') {
      return theme.palette.mode === 'dark' ? '#ffb454' : '#a84a00';
    }
    if (role === 'admin') {
      return theme.palette.mode === 'dark' ? '#58a6ff' : '#1d4ed8';
    }
    return theme.palette.text.secondary;
  };

  const eventAccentColor = (address: string) => {
    if (rolesByAddress[address] === 'owner') return roleColor(address);
    if (rolesByAddress[address] === 'admin') return roleColor(address);
    return theme.palette.mode === 'dark' ? '#f2f2f4' : '#1b1d24';
  };

  const moveMonth = (amount: number) => {
    setMonth((currentMonth) => {
      const nextMonth = currentMonth.clone().add(amount, 'month');
      const selected = moment(selectedDate, 'YYYY-MM-DD', true);
      const nextDate = nextMonth
        .clone()
        .date(
          Math.min(
            selected.isValid() ? selected.date() : 1,
            nextMonth.daysInMonth()
          )
        );
      setSelectedDate(nextDate.format('YYYY-MM-DD'));
      return nextMonth;
    });
  };

  const beginAdd = () => {
    if (moment(selectedDate, 'YYYY-MM-DD', true).isBefore(moment(), 'day'))
      return;
    const next = createForm();
    const nextClockHour = moment().add(1, 'hour').startOf('hour');
    const start = moment(selectedDate, 'YYYY-MM-DD', true)
      .hour(nextClockHour.hour())
      .minute(0)
      .second(0);
    if (
      selectedDate === moment().format('YYYY-MM-DD') &&
      start.isBefore(moment())
    ) {
      start.add(1, 'day');
    }
    const end = start.clone().add(1, 'hour');
    next.startLocal = start.format('YYYY-MM-DDTHH:mm:ss');
    next.endLocal = end.format('YYYY-MM-DDTHH:mm:ss');
    setSelected(null);
    setForm(next);
    setCoverCropFile(null);
    setCoverDraft(null);
    setError('');
    setEditingStep(0);
    setEditing(true);
  };

  const beginEdit = () => {
    if (!selected || selected.occurrenceEnd <= Date.now()) return;
    setForm(createForm(selected));
    setCoverCropFile(null);
    setCoverDraft(null);
    setError('');
    setEditingStep(0);
    setEditing(true);
  };

  const updateStartLocal = (date: string, time: string) => {
    setError('');
    setForm((value) => {
      const nextStart = moment.tz(`${date}T${time}:00`, value.timezone);
      const currentEnd = moment.tz(value.endLocal, value.timezone);
      const nextEnd = currentEnd.isAfter(nextStart)
        ? currentEnd
        : nextStart.clone().add(1, 'hour');
      return {
        ...value,
        startLocal: nextStart.format('YYYY-MM-DDTHH:mm:ss'),
        endLocal: nextEnd.format('YYYY-MM-DDTHH:mm:ss'),
      };
    });
  };

  const updateEndLocal = (date: string, time: string, rollForward: boolean) => {
    setError('');
    setForm((value) => {
      const start = moment.tz(value.startLocal, value.timezone);
      const nextEnd = moment.tz(`${date}T${time}:00`, value.timezone);
      if (rollForward && !nextEnd.isAfter(start)) nextEnd.add(1, 'day');
      return {
        ...value,
        endLocal: nextEnd.format('YYYY-MM-DDTHH:mm:ss'),
      };
    });
  };

  const eventQortalLink = (eventId: string) =>
    buildQortalGroupCalendarLink(groupId, eventId);

  const copyQortalLink = async (link: string) => {
    try {
      await navigator.clipboard.writeText(link);
      setShareCopied(true);
      window.setTimeout(() => setShareCopied(false), 1600);
    } catch {
      setError(
        t('calendar.shareFailed', 'The event link could not be copied.')
      );
    }
  };

  const copyEventLink = (eventId: string) =>
    copyQortalLink(eventQortalLink(eventId));

  const submit = async () => {
    if (!window.reticulumChat || !form.title.trim()) return;
    setError('');
    const trimmedLink = form.link.trim();
    const normalizedLink =
      trimmedLink && !/^[a-z][a-z\d+.-]*:/i.test(trimmedLink)
        ? `https://${trimmedLink}`
        : trimmedLink;
    const input: ReticulumCalendarEventInput = {
      title: form.title,
      description: form.description.slice(0, 500),
      location: form.location,
      link: normalizedLink,
      coverImage: form.coverImage || null,
      allDay: form.allDay,
      timezone: form.timezone,
      startLocal: form.allDay
        ? form.startLocal.slice(0, 10)
        : `${form.startLocal.slice(0, 16)}:00`,
      endLocal: form.allDay
        ? form.endLocal.slice(0, 10)
        : `${form.endLocal.slice(0, 16)}:00`,
      recurrence: form.recurrenceFrequency
        ? {
            frequency: form.recurrenceFrequency,
            ...(form.recurrenceUntil
              ? { untilLocalDate: form.recurrenceUntil }
              : {}),
          }
        : null,
    };
    const start = moment.tz(input.startLocal, input.timezone);
    const end = moment.tz(input.endLocal, input.timezone);
    const startsInPastAtSubmit = form.allDay
      ? start.clone().startOf('day').isBefore(moment().startOf('day'))
      : start.isBefore(moment());
    if (
      !start.isValid() ||
      !end.isValid() ||
      !end.isAfter(start) ||
      startsInPastAtSubmit
    ) {
      setError('');
      setEditingStep(1);
      return;
    }
    if (
      form.recurrenceUntil &&
      form.recurrenceUntil < input.startLocal.slice(0, 10)
    ) {
      setError(
        t(
          'calendar.invalidRepeatUntil',
          'Repeat until must be on or after the start date.'
        )
      );
      setEditingStep(1);
      return;
    }
    if (normalizedLink) {
      try {
        const protocol = new URL(normalizedLink).protocol;
        if (!['https:', 'http:', 'qortal:'].includes(protocol))
          throw new Error();
      } catch {
        setError(
          t(
            'calendar.invalidLink',
            'Enter a valid HTTP, HTTPS, or Qortal link.'
          )
        );
        setEditingStep(1);
        return;
      }
    }
    setSaving(true);
    try {
      const eventId = selected?.eventId || window.crypto.randomUUID();
      if (coverDraft) {
        const metadata = {
          feature: 'reticulum-calendar-cover' as const,
          groupId,
          width: coverDraft.width,
          height: coverDraft.height,
        };
        const imported = await window.reticulumResources?.importBase64?.({
          base64: coverDraft.base64,
          encrypted: false,
          fileName: coverDraft.fileName,
          metadata,
          mimeType: coverDraft.mimeType,
          namespace: 'reticulum-group-resource',
          ownerId: `${groupId}:${ownerAddress}`,
        });
        if (!imported?.success || !imported.manifest) {
          throw new Error(
            imported?.error || 'The compressed cover image could not be saved.'
          );
        }
        const manifest = imported.manifest as Record<string, unknown>;
        if (
          !/^[0-9a-f]{64}$/i.test(String(manifest.fileHash || '')) ||
          !Number.isInteger(Number(manifest.sizeBytes)) ||
          Number(manifest.sizeBytes) <= 0 ||
          Number(manifest.sizeBytes) > 600 * 1024 ||
          !Number.isFinite(Number(manifest.createdAt))
        ) {
          throw new Error('The saved cover image is invalid.');
        }
        input.coverImage = {
          namespace: 'reticulum-group-resource',
          ownerId:
            typeof manifest.ownerId === 'string'
              ? manifest.ownerId
              : `${groupId}:${ownerAddress}`,
          fileName:
            typeof manifest.fileName === 'string'
              ? manifest.fileName
              : coverDraft.fileName,
          mimeType: 'image/webp',
          sizeBytes: Number(manifest.sizeBytes),
          fileHash: String(manifest.fileHash || ''),
          encrypted: false,
          createdAt: Number(manifest.createdAt),
          metadata,
        };
      }
      let createdEventLink = '';
      if (selected) {
        await window.reticulumChat.updateCalendarEvent(
          groupId,
          selected.eventId,
          input
        );
      } else {
        const result = (await window.reticulumChat.createCalendarEvent(
          groupId,
          input,
          eventId
        )) as { eventId?: string };
        const createdEventId = String(result?.eventId || '');
        if (createdEventId) {
          createdEventLink = eventQortalLink(
            createdEventId,
            moment.tz(input.startLocal, input.timezone).valueOf(),
            input.timezone
          );
        }
      }
      setEditing(false);
      setCoverDraft(null);
      setCoverCropFile(null);
      await load();
      if (createdEventLink) setPostSuccessLink(createdEventLink);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!selected || !window.reticulumChat?.deleteCalendarEvent) return;
    setSaving(true);
    try {
      await window.reticulumChat.deleteCalendarEvent(groupId, selected.eventId);
      setDeleteConfirmationOpen(false);
      setSelected(null);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      fullScreen={narrow}
      fullWidth
      maxWidth="lg"
      open={open}
      onClose={onClose}
      PaperProps={{
        sx: {
          bgcolor: 'background.paper',
          backgroundImage: 'none',
          height: narrow ? '100%' : 'min(860px, calc(100vh - 12px))',
        },
      }}
    >
      <DialogTitle sx={{ alignItems: 'center', display: 'flex', gap: 1 }}>
        <EventRoundedIcon color="primary" />
        <Box sx={{ flex: 1 }}>
          <Typography component="div" fontSize={18} fontWeight={700}>
            {t('calendar.title', 'Group Calendar')}
          </Typography>
          <Typography color="text.secondary" fontSize={12}>
            {t('calendar.subtitle', 'Events shared with this group')}
          </Typography>
        </Box>
        {canManage && (
          <Button
            startIcon={<AddRoundedIcon />}
            onClick={beginAdd}
            disabled={moment(selectedDate, 'YYYY-MM-DD', true).isBefore(
              moment(),
              'day'
            )}
            sx={{
              alignItems: 'center',
              backgroundColor: RETICULUM_ACTIVE_BLUE,
              border: 0,
              borderRadius: '8px',
              color: theme.palette.common.white,
              display: 'inline-flex',
              fontSize: 14,
              fontWeight: 500,
              gap: '6px',
              height: 38,
              minWidth: 74,
              px: '14px',
              py: '8px',
              transition: 'background-color 0.2s ease',
              '&:hover': { backgroundColor: RETICULUM_ACTIVE_BLUE_HOVER },
              '&.Mui-disabled': {
                backgroundColor: alpha(RETICULUM_ACTIVE_BLUE, 0.28),
                color: alpha(theme.palette.common.white, 0.42),
              },
              '& .MuiSvgIcon-root': {
                color: theme.palette.common.white,
                fontSize: 18,
              },
            }}
          >
            {t('calendar.add', 'Add event')}
          </Button>
        )}
        <IconButton aria-label={t('common.close', 'Close')} onClick={onClose}>
          <CloseRoundedIcon />
        </IconButton>
      </DialogTitle>
      <Divider />
      <DialogContent
        sx={{ display: 'flex', flexDirection: 'column', minHeight: 0, p: 0 }}
      >
        {error && (
          <Alert severity="error" sx={{ m: 2, mb: 0 }}>
            {error}
          </Alert>
        )}
        <Box
          sx={{
            display: 'grid',
            flex: 1,
            gridTemplateColumns: narrow
              ? '1fr'
              : 'minmax(480px, 1.4fr) minmax(300px, .8fr)',
            minHeight: 0,
          }}
        >
          <Box
            sx={{
              border: `1px solid ${alpha(theme.palette.text.primary, 0.08)}`,
              borderRadius: 2,
              boxShadow: `0 8px 24px ${alpha(
                theme.palette.common.black,
                theme.palette.mode === 'dark' ? 0.16 : 0.08
              )}, inset 0 1px 0 ${alpha(
                theme.palette.common.white,
                theme.palette.mode === 'dark' ? 0.025 : 0.42
              )}`,
              display: 'flex',
              flexDirection: 'column',
              m: 1.5,
              mb: narrow ? 0.75 : 1.5,
              mr: narrow ? 1.5 : 0.75,
              minHeight: 0,
              p: 2,
            }}
          >
            <Box sx={{ alignItems: 'center', display: 'flex', mb: 1 }}>
              <IconButton
                aria-label="Previous month"
                onClick={() => moveMonth(-1)}
                sx={{
                  bgcolor: alpha(theme.palette.text.primary, 0.045),
                  borderRadius: 2,
                  height: 40,
                  transition: 'background-color 0.18s ease, color 0.18s ease',
                  width: 40,
                  '&:hover': {
                    bgcolor: alpha(theme.palette.text.primary, 0.095),
                  },
                }}
              >
                <ChevronLeftRoundedIcon />
              </IconButton>
              <Typography
                sx={{
                  flex: 1,
                  fontSize: 18,
                  fontWeight: 700,
                  textAlign: 'center',
                }}
              >
                {new Intl.DateTimeFormat(i18n.language, {
                  month: 'long',
                  year: 'numeric',
                }).format(month.toDate())}
              </Typography>
              <Button
                size="small"
                onClick={() => {
                  setMonth(moment().startOf('month'));
                  setSelectedDate(moment().format('YYYY-MM-DD'));
                }}
              >
                {t('calendar.today', 'Today')}
              </Button>
              <IconButton
                aria-label="Next month"
                onClick={() => moveMonth(1)}
                sx={{
                  bgcolor: alpha(theme.palette.text.primary, 0.045),
                  borderRadius: 2,
                  height: 40,
                  transition: 'background-color 0.18s ease, color 0.18s ease',
                  width: 40,
                  '&:hover': {
                    bgcolor: alpha(theme.palette.text.primary, 0.095),
                  },
                }}
              >
                <ChevronRightRoundedIcon />
              </IconButton>
            </Box>
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: 'repeat(7, 1fr)',
                gridTemplateRows: narrow ? undefined : 'auto repeat(6, 90px)',
                minHeight: 0,
              }}
            >
              {days.slice(0, 7).map((day) => (
                <Typography
                  color="text.secondary"
                  fontSize={11}
                  fontWeight={700}
                  key={day.valueOf()}
                  sx={{
                    py: 1,
                    textAlign: 'center',
                    textTransform: 'uppercase',
                  }}
                >
                  {new Intl.DateTimeFormat(i18n.language, {
                    weekday: 'short',
                  }).format(day.toDate())}
                </Typography>
              ))}
              {days.map((day) => {
                const key = day.format('YYYY-MM-DD');
                const dayEvents = eventsByDay.get(key) || [];
                const active = key === selectedDate;
                const today = key === moment().format('YYYY-MM-DD');
                const past = day.isBefore(moment().startOf('day'), 'day');
                return (
                  <Button
                    key={key}
                    aria-label={day.format('LL')}
                    onClick={() => setSelectedDate(key)}
                    sx={{
                      alignItems: 'stretch',
                      border: `1px solid ${active ? theme.palette.primary.main : theme.palette.divider}`,
                      borderRadius: 0,
                      color:
                        !past && day.month() === month.month()
                          ? 'text.primary'
                          : 'text.disabled',
                      display: 'flex',
                      flexDirection: 'column',
                      justifyContent: 'flex-start',
                      height: { xs: 82, md: 90 },
                      minHeight: { xs: 82, md: 90 },
                      minWidth: 0,
                      p: 0.75,
                      textAlign: 'left',
                      textTransform: 'none',
                    }}
                  >
                    <Box
                      component="span"
                      sx={{
                        alignItems: 'center',
                        bgcolor: today ? 'primary.main' : 'transparent',
                        borderRadius: '50%',
                        color: today ? 'primary.contrastText' : 'inherit',
                        display: 'inline-flex',
                        height: 24,
                        justifyContent: 'center',
                        width: 24,
                      }}
                    >
                      {day.date()}
                    </Box>
                    <Stack
                      spacing={0.35}
                      sx={{ mt: 0.5, overflow: 'hidden', width: '100%' }}
                    >
                      {dayEvents.slice(0, 2).map((event) => (
                        <Box
                          component="span"
                          key={event.occurrenceId}
                          sx={{
                            bgcolor: 'action.selected',
                            borderLeft: `2px solid ${eventAccentColor(event.creatorAddress)}`,
                            borderRadius: 0.5,
                            fontSize: 10,
                            overflow: 'hidden',
                            px: 0.5,
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {event.title}
                        </Box>
                      ))}
                      {dayEvents.length > 2 && (
                        <Typography
                          component="span"
                          color="text.secondary"
                          fontSize={10}
                        >
                          +{dayEvents.length - 2}
                        </Typography>
                      )}
                    </Stack>
                  </Button>
                );
              })}
            </Box>
          </Box>
          <Box
            sx={{
              border: `1px solid ${alpha(theme.palette.text.primary, 0.08)}`,
              borderRadius: 2,
              boxShadow: `0 8px 24px ${alpha(
                theme.palette.common.black,
                theme.palette.mode === 'dark' ? 0.14 : 0.07
              )}, inset 0 1px 0 ${alpha(
                theme.palette.common.white,
                theme.palette.mode === 'dark' ? 0.022 : 0.4
              )}`,
              display: 'flex',
              flexDirection: 'column',
              m: 1.5,
              mb: 1.5,
              ml: narrow ? 1.5 : 0.75,
              mt: narrow ? 0.75 : 1.5,
              minHeight: 280,
              overflowX: 'hidden',
              overflowY: 'auto',
              p: 2,
            }}
          >
            {loading ? (
              <Box sx={{ display: 'grid', flex: 1, placeItems: 'center' }}>
                <CircularProgress size={28} />
              </Box>
            ) : (
              visibleAgendaDays.map((day, dayIndex) => (
                <Box key={day.key} sx={{ mb: dayIndex === 0 ? 2.5 : 2 }}>
                  {dayIndex === 1 && (
                    <Typography
                      fontSize={16}
                      fontWeight={700}
                      sx={{
                        borderBottom: `1px solid ${theme.palette.divider}`,
                        borderTop: `1px solid ${theme.palette.divider}`,
                        mb: 1.5,
                        mt: 0.5,
                        py: 1.25,
                      }}
                    >
                      {t('calendar.upcomingEvents', 'Upcoming Events')}
                    </Typography>
                  )}
                  <Typography fontSize={16} fontWeight={700}>
                    {new Intl.DateTimeFormat(i18n.language, {
                      weekday: 'long',
                      month: 'long',
                      day: 'numeric',
                    }).format(day.date.toDate())}
                  </Typography>
                  <Typography
                    color="text.secondary"
                    fontSize={12}
                    sx={{ mb: 1 }}
                  >
                    {day.events.length
                      ? t('calendar.eventCount', '{{count}} events', {
                          count: day.events.length,
                        })
                      : t('calendar.noEvents', 'No events')}
                  </Typography>
                  {day.events.map((event) => (
                    <Button
                      key={event.occurrenceId}
                      onClick={() => setSelected(event)}
                      sx={{
                        alignItems: 'flex-start',
                        bgcolor:
                          selected?.occurrenceId === event.occurrenceId
                            ? 'action.selected'
                            : 'transparent',
                        border: `1px solid ${theme.palette.divider}`,
                        borderRadius: 2,
                        color: 'text.primary',
                        display: 'flex',
                        flexDirection: 'column',
                        mb: 1,
                        p: 1.5,
                        textAlign: 'left',
                        textTransform: 'none',
                        width: '100%',
                        '&:hover': {
                          bgcolor: alpha(
                            theme.palette.primary.main,
                            theme.palette.action.hoverOpacity
                          ),
                        },
                      }}
                    >
                      <Typography
                        fontWeight={750}
                        sx={{
                          display: '-webkit-box',
                          overflow: 'hidden',
                          overflowWrap: 'anywhere',
                          WebkitBoxOrient: 'vertical',
                          WebkitLineClamp: 2,
                          width: '100%',
                        }}
                      >
                        {event.title}
                      </Typography>
                      <Typography color="text.secondary" fontSize={12}>
                        {event.allDay
                          ? t('calendar.allDay', 'All day')
                          : moment(event.occurrenceStart).format('HH:mm')}{' '}
                        · {t('calendar.yourTime', '(your time)')}
                        {event.location ? ` · ${event.location}` : ''}
                      </Typography>
                      {event.creatorAddress && (
                        <Typography color="text.secondary" fontSize={12}>
                          {t('calendar.createdBy', 'Created by')}{' '}
                          <Box
                            component="span"
                            sx={{
                              color: roleColor(event.creatorAddress),
                              fontWeight: rolesByAddress[event.creatorAddress]
                                ? 750
                                : 500,
                            }}
                          >
                            {creatorLabel(event.creatorAddress)}
                          </Box>
                        </Typography>
                      )}
                    </Button>
                  ))}
                  {dayIndex === 0 && weeklyAgendaEmpty && (
                    <Box
                      sx={{
                        alignItems: 'center',
                        display: 'flex',
                        flexDirection: 'column',
                        px: 2,
                        py: 5,
                        textAlign: 'center',
                      }}
                    >
                      <EventBusyRoundedIcon
                        sx={{
                          color: alpha(theme.palette.text.secondary, 0.52),
                          fontSize: 72,
                          mb: 2,
                        }}
                      />
                      <Typography fontSize={16} fontWeight={650}>
                        {t('calendar.noEventsScheduled', 'No events scheduled')}
                      </Typography>
                      <Typography
                        color="text.secondary"
                        fontSize={13}
                        sx={{ mt: 0.75 }}
                      >
                        {t(
                          'calendar.nothingElseScheduledThisWeek',
                          'Nothing else scheduled for this week.'
                        )}
                      </Typography>
                      {canManage && (
                        <Button
                          startIcon={<AddRoundedIcon />}
                          disabled={moment(
                            selectedDate,
                            'YYYY-MM-DD',
                            true
                          ).isBefore(moment(), 'day')}
                          onClick={beginAdd}
                          sx={{
                            bgcolor: alpha(theme.palette.text.primary, 0.035),
                            border: `1px solid ${alpha(
                              theme.palette.text.primary,
                              0.16
                            )}`,
                            borderRadius: '8px',
                            color: 'text.secondary',
                            fontWeight: 600,
                            mt: 2.5,
                            px: 2,
                            textTransform: 'none',
                            transition:
                              'background-color 0.2s ease, border-color 0.2s ease, color 0.2s ease',
                            '&:hover': {
                              bgcolor: RETICULUM_ACTIVE_BLUE,
                              borderColor: RETICULUM_ACTIVE_BLUE,
                              color: theme.palette.common.white,
                            },
                          }}
                        >
                          {t('calendar.add', 'Add event')}
                        </Button>
                      )}
                    </Box>
                  )}
                  {dayIndex === 0 &&
                    !weeklyAgendaEmpty &&
                    upcomingAgendaDays.length === 0 && (
                      <Box
                        sx={{
                          borderBottom: `1px solid ${theme.palette.divider}`,
                          borderTop: `1px solid ${theme.palette.divider}`,
                          mt: 2,
                          py: 1.25,
                        }}
                      >
                        <Typography fontSize={16} fontWeight={700}>
                          {t('calendar.upcomingEvents', 'Upcoming Events')}
                        </Typography>
                        <Typography
                          color="text.secondary"
                          fontSize={12}
                          sx={{ mt: 0.5 }}
                        >
                          {t(
                            'calendar.noUpcomingEventsThisWeek',
                            'There are no upcoming events for this week.'
                          )}
                        </Typography>
                      </Box>
                    )}
                </Box>
              ))
            )}
          </Box>
        </Box>
      </DialogContent>

      <Dialog
        open={editing}
        onClose={(_event, reason) => {
          if (reason === 'backdropClick') return;
          if (!saving) setEditing(false);
        }}
        fullWidth
        maxWidth="sm"
        BackdropProps={{
          sx: {
            backdropFilter: 'blur(1.5px)',
            backgroundColor: 'rgba(2, 6, 12, 0.76)',
          },
        }}
        PaperProps={{
          sx: {
            bgcolor: wizardColors.modal,
            backgroundImage: wizardColors.modalGradient,
            border: `1px solid ${wizardColors.border}`,
            borderRadius: '10px',
            boxShadow:
              '0 28px 80px rgba(0, 0, 0, 0.62), inset 0 1px 0 rgba(255, 255, 255, 0.035)',
            color: wizardColors.heading,
            overflow: 'hidden',
            width: 'min(560px, calc(100vw - 32px))',
            '& .MuiOutlinedInput-root': {
              backgroundColor: wizardColors.field,
              borderRadius: '8px',
              color: wizardColors.entered,
              '& fieldset': { borderColor: wizardColors.border },
              '&:hover fieldset': {
                borderColor: wizardColors.borderHover,
              },
              '&.Mui-focused fieldset': {
                borderColor: wizardColors.focus,
                borderWidth: 1,
              },
              '&.Mui-disabled': {
                backgroundColor: wizardColors.fieldDisabled,
                color: wizardColors.disabled,
              },
            },
            '& .MuiInputBase-input.Mui-disabled': {
              WebkitTextFillColor: wizardColors.disabled,
            },
            '& .MuiInputLabel-root': {
              color: wizardColors.label,
              fontSize: 13,
              '&.Mui-focused': { color: wizardColors.focusLabel },
              '&.Mui-disabled': { color: wizardColors.disabled },
            },
            '& .MuiInputBase-input::placeholder': {
              color: wizardColors.placeholder,
              opacity: 1,
            },
            '& .MuiSelect-icon, & input::-webkit-calendar-picker-indicator': {
              color: wizardColors.label,
              cursor: 'pointer',
              filter: theme.palette.mode === 'dark' ? 'invert(0.78)' : 'none',
              opacity: 0.82,
              transition: 'filter 0.16s ease, opacity 0.16s ease',
            },
            '& input::-webkit-calendar-picker-indicator:hover': {
              filter:
                theme.palette.mode === 'dark'
                  ? 'invert(1) brightness(1.35)'
                  : 'brightness(0.62)',
              opacity: 1,
            },
          },
        }}
      >
        <DialogTitle
          sx={{
            alignItems: 'center',
            display: 'flex',
            fontSize: 13,
            fontWeight: 600,
            px: 3,
            pb: 0,
            pt: 2.5,
          }}
        >
          <Box sx={{ color: theme.palette.primary.main, flex: 1 }}>
            {selected
              ? t('calendar.edit', 'Edit event')
              : t('calendar.add', 'Add event')}
          </Box>
          <IconButton
            aria-label={t('common.close', 'Close')}
            disabled={saving}
            onClick={() => setEditing(false)}
            size="small"
            sx={{ color: wizardColors.label }}
          >
            <CloseRoundedIcon fontSize="small" />
          </IconButton>
        </DialogTitle>
        <DialogContent sx={{ px: 3, pb: 2, pt: 1.5 }}>
          {error && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {error}
            </Alert>
          )}
          {editingStep === 0 && (
            <Stack spacing={2} sx={{ pt: 1 }}>
              <Box>
                <Typography
                  color={wizardColors.heading}
                  fontSize={22}
                  fontWeight={800}
                >
                  {t('calendar.eventDetails', 'Event details')}
                </Typography>
                <Typography color={wizardColors.subtitle} fontSize={13}>
                  {t(
                    'calendar.eventDetailsHelp',
                    'Add a title and description for the event.'
                  )}
                </Typography>
              </Box>
              <Box>
                <Typography
                  color={wizardColors.label}
                  fontSize={13}
                  fontWeight={600}
                  sx={{ mb: 0.75 }}
                >
                  {t('calendar.eventTitle', 'Title')}
                </Typography>
                <TextField
                  autoFocus
                  fullWidth
                  inputProps={{ maxLength: 120 }}
                  placeholder={t(
                    'calendar.eventTitlePlaceholder',
                    'Event title'
                  )}
                  value={form.title}
                  onChange={(e) =>
                    setForm((value) => ({ ...value, title: e.target.value }))
                  }
                />
              </Box>
              <Box>
                <Typography
                  color={wizardColors.label}
                  fontSize={13}
                  fontWeight={600}
                  sx={{ mb: 0.75 }}
                >
                  {t('calendar.description', 'Description')}
                </Typography>
                <TextField
                  fullWidth
                  multiline
                  minRows={8}
                  inputProps={{ maxLength: 500 }}
                  placeholder={t(
                    'calendar.descriptionPlaceholder',
                    'Add a description for the event…'
                  )}
                  value={form.description}
                  onChange={(e) =>
                    setForm((value) => ({
                      ...value,
                      description: e.target.value,
                    }))
                  }
                />
              </Box>
              <Box
                sx={{
                  alignItems: 'center',
                  display: 'flex',
                  gap: 2,
                  justifyContent: 'space-between',
                }}
              >
                <Box sx={{ minWidth: 0 }}>
                  <Typography
                    color={wizardColors.label}
                    fontSize={13}
                    fontWeight={600}
                  >
                    {t('calendar.coverImage', 'Cover Image')}
                  </Typography>
                  <Typography color={wizardColors.subtitle} fontSize={12}>
                    {t(
                      'calendar.coverImageHelp',
                      '16:9 ratio · recommended size 1200 × 675'
                    )}
                  </Typography>
                </Box>
                <input
                  ref={coverInputRef}
                  accept="image/jpeg,image/png,image/webp"
                  hidden
                  type="file"
                  onChange={(event) => {
                    const file = event.target.files?.[0] || null;
                    event.target.value = '';
                    if (!file) return;
                    if (
                      !['image/jpeg', 'image/png', 'image/webp'].includes(
                        file.type
                      )
                    ) {
                      setError(
                        t(
                          'calendar.coverImageTypeError',
                          'Choose a JPEG, PNG, or WebP image.'
                        )
                      );
                      return;
                    }
                    if (file.size <= 0 || file.size > 25 * 1024 * 1024) {
                      setError(
                        t(
                          'calendar.coverImageSizeError',
                          'The cover image must be smaller than 25 MB.'
                        )
                      );
                      return;
                    }
                    setError('');
                    setCoverCropFile(file);
                  }}
                />
                <Button
                  aria-label={
                    coverDraft || form.coverImage
                      ? t('calendar.coverImageReady', 'Cover image ready')
                      : t('calendar.uploadCover', 'Upload Banner')
                  }
                  onClick={() => coverInputRef.current?.click()}
                  startIcon={
                    coverDraft || form.coverImage ? undefined : (
                      <UploadRoundedIcon />
                    )
                  }
                  sx={{
                    backgroundColor:
                      coverDraft || form.coverImage
                        ? RETICULUM_ACTIVE_BLUE
                        : 'transparent',
                    border: `1px solid ${
                      coverDraft || form.coverImage
                        ? RETICULUM_ACTIVE_BLUE
                        : theme.palette.common.white
                    }`,
                    borderRadius: '8px',
                    color: theme.palette.common.white,
                    flexShrink: 0,
                    height: 38,
                    minWidth: 148,
                    textTransform: 'none',
                    transition:
                      'background-color 0.18s ease, color 0.18s ease',
                    '&:hover': {
                      backgroundColor: RETICULUM_ACTIVE_BLUE,
                      borderColor: RETICULUM_ACTIVE_BLUE,
                      color: theme.palette.common.white,
                    },
                  }}
                >
                  {coverDraft || form.coverImage ? (
                    <CheckRoundedIcon />
                  ) : (
                    t('calendar.uploadCover', 'Upload Banner')
                  )}
                </Button>
              </Box>
            </Stack>
          )}

          {editingStep === 1 && (
            <Stack spacing={2} sx={{ pt: 1 }}>
              <Box>
                <Typography
                  color={wizardColors.heading}
                  fontSize={22}
                  fontWeight={800}
                >
                  {t('calendar.timeAndLocation', 'Time & Location')}
                </Typography>
                <Typography color={wizardColors.subtitle} fontSize={13}>
                  {t(
                    'calendar.timeAndLocationHelp',
                    'Choose when and where the event takes place.'
                  )}
                </Typography>
              </Box>
              <Box
                sx={{
                  bgcolor: wizardColors.field,
                  border: `1px solid ${wizardColors.border}`,
                  borderRadius: '8px',
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr',
                  p: 0.5,
                }}
              >
                {[
                  { allDay: false, label: t('calendar.timed', 'Timed') },
                  { allDay: true, label: t('calendar.allDay', 'All Day') },
                ].map((option) => (
                  <Button
                    key={String(option.allDay)}
                    onClick={() =>
                      setForm((value) => {
                        if (!option.allDay) return { ...value, allDay: false };
                        const startDate = value.startLocal.slice(0, 10);
                        const endDate = value.endLocal.slice(0, 10);
                        return {
                          ...value,
                          allDay: true,
                          endLocal:
                            endDate <= startDate
                              ? `${moment(startDate).add(1, 'day').format('YYYY-MM-DD')}T${value.endLocal.slice(11, 16) || '00:00'}:00`
                              : value.endLocal,
                        };
                      })
                    }
                    sx={{
                      bgcolor:
                        form.allDay === option.allDay
                          ? theme.palette.action.selected
                          : 'transparent',
                      borderRadius: '6px',
                      color:
                        form.allDay === option.allDay
                          ? wizardColors.heading
                          : wizardColors.label,
                      fontWeight: 650,
                      '&:hover': { bgcolor: theme.palette.action.hover },
                      textTransform: 'none',
                    }}
                  >
                    {option.label}
                  </Button>
                ))}
              </Box>
              <Box
                sx={{
                  display: 'grid',
                  gap: 2,
                  gridTemplateColumns: narrow ? '1fr' : '1fr 1fr',
                }}
              >
                <TextField
                  disabled={form.allDay}
                  label={t('calendar.startDate', 'Start Date')}
                  type="date"
                  InputLabelProps={{ shrink: true }}
                  inputProps={{ min: moment().format('YYYY-MM-DD') }}
                  value={form.startLocal.slice(0, 10)}
                  onChange={(e) => {
                    if (e.target.value < moment().format('YYYY-MM-DD')) return;
                    updateStartLocal(
                      e.target.value,
                      form.startLocal.slice(11, 16) || '00:00'
                    );
                  }}
                />
                <TextField
                  disabled={form.allDay}
                  label={t('calendar.startTime', 'Start Time')}
                  type="time"
                  InputLabelProps={{ shrink: true }}
                  inputProps={{
                    min:
                      form.startLocal.slice(0, 10) ===
                      moment().format('YYYY-MM-DD')
                        ? moment().format('HH:mm')
                        : undefined,
                    step: 900,
                  }}
                  value={form.startLocal.slice(11, 16)}
                  onChange={(e) => {
                    if (
                      form.startLocal.slice(0, 10) ===
                        moment().format('YYYY-MM-DD') &&
                      e.target.value < moment().format('HH:mm')
                    )
                      return;
                    updateStartLocal(
                      form.startLocal.slice(0, 10),
                      e.target.value
                    );
                  }}
                />
                <TextField
                  disabled={form.allDay}
                  label={t('calendar.endDate', 'End Date')}
                  type="date"
                  InputLabelProps={{ shrink: true }}
                  inputProps={{ min: form.startLocal.slice(0, 10) }}
                  value={form.endLocal.slice(0, 10)}
                  onChange={(e) => {
                    if (e.target.value < form.startLocal.slice(0, 10)) return;
                    updateEndLocal(
                      e.target.value,
                      form.endLocal.slice(11, 16) || '00:00',
                      false
                    );
                  }}
                />
                <TextField
                  disabled={form.allDay}
                  label={t('calendar.endTime', 'End Time')}
                  type="time"
                  InputLabelProps={{ shrink: true }}
                  inputProps={{ step: 900 }}
                  value={form.endLocal.slice(11, 16)}
                  onChange={(e) =>
                    updateEndLocal(
                      form.endLocal.slice(0, 10),
                      e.target.value,
                      true
                    )
                  }
                />
              </Box>
              <TextField
                select
                label={t('calendar.repeats', 'Repeats')}
                value={form.recurrenceFrequency}
                onChange={(e) =>
                  setForm((value) => ({
                    ...value,
                    recurrenceFrequency: e.target
                      .value as FormState['recurrenceFrequency'],
                  }))
                }
              >
                <MenuItem value="">
                  {t('calendar.doesNotRepeat', 'Does not repeat')}
                </MenuItem>
                <MenuItem value="daily">
                  {t('calendar.daily', 'Daily')}
                </MenuItem>
                <MenuItem value="weekly">
                  {t('calendar.weekly', 'Weekly')}
                </MenuItem>
                <MenuItem value="monthly">
                  {t('calendar.monthly', 'Monthly')}
                </MenuItem>
                <MenuItem value="yearly">
                  {t('calendar.yearly', 'Yearly')}
                </MenuItem>
              </TextField>
              {form.recurrenceFrequency && (
                <TextField
                  type="date"
                  label={t('calendar.repeatUntil', 'Repeat until (optional)')}
                  InputLabelProps={{ shrink: true }}
                  inputProps={{ min: form.startLocal.slice(0, 10) }}
                  value={form.recurrenceUntil}
                  onChange={(e) => {
                    if (
                      e.target.value &&
                      e.target.value < form.startLocal.slice(0, 10)
                    )
                      return;
                    setForm((value) => ({
                      ...value,
                      recurrenceUntil: e.target.value,
                    }));
                  }}
                />
              )}
              <TextField
                label={t('calendar.location', 'Location')}
                inputProps={{ maxLength: 240 }}
                placeholder={t(
                  'calendar.locationPlaceholder',
                  'Add a location'
                )}
                value={form.location}
                onChange={(e) =>
                  setForm((value) => ({ ...value, location: e.target.value }))
                }
              />
              <TextField
                label={t('calendar.link', 'Link')}
                inputProps={{ maxLength: 2048 }}
                placeholder={t(
                  'calendar.linkPlaceholder',
                  'Add a link (optional)'
                )}
                value={form.link}
                onChange={(e) =>
                  setForm((value) => ({ ...value, link: e.target.value }))
                }
              />
            </Stack>
          )}

          {editingStep === 2 && (
            <Box sx={{ pt: 1 }}>
              <Typography
                color={wizardColors.heading}
                fontSize={22}
                fontWeight={800}
                sx={{ mb: 2 }}
              >
                {t('calendar.overview', 'Overview')}
              </Typography>
              <Box
                sx={{
                  minWidth: 0,
                }}
              >
                <Stack spacing={2}>
                  <Box>
                    <Typography fontSize={14} fontWeight={750}>
                      {t('calendar.eventTitle', 'Title')}
                    </Typography>
                    <Typography
                      color={wizardColors.subtitle}
                      fontSize={13}
                      sx={{ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}
                    >
                      {form.title}
                    </Typography>
                  </Box>
                  {form.description && (
                    <Box>
                      <Typography fontSize={14} fontWeight={750}>
                        {t('calendar.description', 'Description')}
                      </Typography>
                      <Typography
                        color={wizardColors.subtitle}
                        fontSize={13}
                        sx={{
                          overflowWrap: 'anywhere',
                          whiteSpace: 'pre-wrap',
                        }}
                      >
                        {form.description}
                      </Typography>
                    </Box>
                  )}
                  <Box>
                    <Typography fontSize={14} fontWeight={750}>
                      {t('calendar.time', 'Time')}
                    </Typography>
                    <Typography color={wizardColors.subtitle} fontSize={13}>
                      {form.allDay
                        ? t('calendar.allDay', 'All Day')
                        : `${formatWizardDateTime(form.startLocal)} – ${formatWizardDateTime(form.endLocal)}`}
                    </Typography>
                  </Box>
                  {form.location && (
                    <Box>
                      <Typography fontSize={14} fontWeight={750}>
                        {t('calendar.location', 'Location')}
                      </Typography>
                      <Typography
                        color={wizardColors.subtitle}
                        fontSize={13}
                        sx={{
                          overflowWrap: 'anywhere',
                          whiteSpace: 'pre-wrap',
                        }}
                      >
                        {form.location}
                      </Typography>
                    </Box>
                  )}
                  {form.link && (
                    <Box>
                      <Typography fontSize={14} fontWeight={750}>
                        {t('calendar.link', 'Link')}
                      </Typography>
                      <Typography
                        color={wizardColors.subtitle}
                        fontSize={13}
                        sx={{
                          overflowWrap: 'anywhere',
                          whiteSpace: 'pre-wrap',
                        }}
                      >
                        {form.link}
                      </Typography>
                    </Box>
                  )}
                </Stack>
              </Box>
            </Box>
          )}
        </DialogContent>
        <DialogActions
          sx={{
            borderTop: `1px solid ${wizardColors.divider}`,
            justifyContent: 'space-between',
            px: 3,
            py: 2,
          }}
        >
          <Button
            disabled={saving}
            onClick={() =>
              editingStep > 0
                ? setEditingStep((step) => step - 1)
                : setEditing(false)
            }
            sx={{
              color: wizardColors.label,
              fontWeight: 600,
              px: 0,
              textTransform: 'none',
              '&:hover': {
                bgcolor: 'transparent',
                color: wizardColors.heading,
              },
            }}
          >
            {t('common.back', 'Back')}
          </Button>
          <Stack direction="row" spacing={1}>
            <Button
              disabled={saving}
              onClick={() => setEditing(false)}
              sx={{
                bgcolor: wizardColors.secondaryButton,
                border: `1px solid ${wizardColors.border}`,
                borderRadius: '8px',
                boxShadow: 'none',
                color: wizardColors.entered,
                fontWeight: 650,
                minWidth: 88,
                textTransform: 'none',
                '&:hover': { bgcolor: wizardColors.secondaryButtonHover },
              }}
            >
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button
              onClick={() =>
                editingStep < 2
                  ? setEditingStep((step) => step + 1)
                  : void submit()
              }
              disabled={
                saving ||
                ((editingStep === 0 || editingStep === 2) &&
                  !form.title.trim()) ||
                (editingStep === 1 && !formTimingValid)
              }
              sx={{
                alignItems: 'center',
                backgroundColor: RETICULUM_ACTIVE_BLUE,
                border: 0,
                borderRadius: '8px',
                boxShadow: 'none',
                color: theme.palette.common.white,
                display: 'inline-flex',
                fontSize: 14,
                fontWeight: 500,
                gap: '6px',
                height: 38,
                minWidth: 74,
                px: '14px',
                py: '8px',
                textTransform: 'none',
                transition: 'background-color 0.2s ease',
                '&:hover': { backgroundColor: RETICULUM_ACTIVE_BLUE_HOVER },
                '&.Mui-disabled': {
                  backgroundColor: 'rgba(63, 81, 181, 0.42)',
                  color: 'rgba(224, 229, 238, 0.48)',
                },
              }}
            >
              {saving ? (
                <CircularProgress color="inherit" size={20} />
              ) : editingStep < 2 ? (
                t('common.next', 'Next')
              ) : (
                t('calendar.post', 'Post')
              )}
            </Button>
          </Stack>
        </DialogActions>
      </Dialog>

      <EventCoverCropDialog
        file={coverCropFile}
        open={Boolean(coverCropFile)}
        onClose={() => setCoverCropFile(null)}
        onApply={(draft) => {
          setCoverDraft(draft);
          setCoverCropFile(null);
        }}
      />

      <Dialog
        open={Boolean(postSuccessLink)}
        onClose={() => {
          setPostSuccessLink('');
          setShareCopied(false);
        }}
        fullWidth
        maxWidth="xs"
        BackdropProps={{
          sx: {
            backdropFilter: 'blur(1.5px)',
            backgroundColor: 'rgba(2, 6, 12, 0.76)',
          },
        }}
        PaperProps={{
          sx: {
            bgcolor: wizardColors.modal,
            backgroundImage: wizardColors.modalGradient,
            border: `1px solid ${wizardColors.border}`,
            borderRadius: '10px',
            boxShadow:
              '0 28px 80px rgba(0, 0, 0, 0.62), inset 0 1px 0 rgba(255, 255, 255, 0.035)',
            color: wizardColors.heading,
            isolation: 'isolate',
            overflow: 'visible',
            position: 'relative',
          },
        }}
      >
        <Confetti
          key={postSuccessLink}
          aria-hidden="true"
          manualstart={false}
          options={celebrationConfettiOptions}
          style={{
            bottom: '-36px',
            height: '560px',
            left: '50%',
            pointerEvents: 'none',
            position: 'absolute',
            transform: 'translateX(-50%)',
            width: 'min(900px, 100vw)',
            zIndex: -1,
          }}
        />
        <DialogTitle
          sx={{ alignItems: 'center', display: 'flex', gap: 1, px: 3 }}
        >
          <Typography
            component="div"
            fontSize={20}
            fontWeight={800}
            sx={{ flex: 1 }}
          >
            {t('calendar.eventCreated', 'Event successfully created!')}
          </Typography>
          <IconButton
            aria-label={t('common.close', 'Close')}
            onClick={() => {
              setPostSuccessLink('');
              setShareCopied(false);
            }}
          >
            <CloseRoundedIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent sx={{ px: 3, pb: 3 }}>
          <Typography
            color={wizardColors.label}
            fontSize={13}
            fontWeight={650}
            sx={{ mb: 0.75 }}
          >
            {t('calendar.eventLink', 'Event link')}
          </Typography>
          <Box
            sx={{
              alignItems: 'center',
              bgcolor: wizardColors.field,
              border: `1px solid ${wizardColors.border}`,
              borderRadius: '8px',
              display: 'flex',
              gap: 1,
              minWidth: 0,
              p: 1,
            }}
          >
            <Typography
              color={wizardColors.entered}
              fontSize={13}
              sx={{
                flex: 1,
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {postSuccessLink}
            </Typography>
            <Button
              onClick={() => void copyQortalLink(postSuccessLink)}
              sx={{
                backgroundColor: RETICULUM_ACTIVE_BLUE,
                borderRadius: '8px',
                color: theme.palette.common.white,
                flexShrink: 0,
                fontWeight: 600,
                minWidth: 72,
                textTransform: 'none',
                '&:hover': { backgroundColor: RETICULUM_ACTIVE_BLUE_HOVER },
              }}
            >
              {shareCopied
                ? t('calendar.copied', 'Copied')
                : t('calendar.copy', 'Copy')}
            </Button>
          </Box>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(selected) && !editing}
        onClose={() => setSelected(null)}
        fullWidth
        maxWidth="sm"
        PaperProps={{
          sx: {
            bgcolor: wizardColors.modal,
            backgroundImage: wizardColors.modalGradient,
            border: `1px solid ${wizardColors.border}`,
            borderRadius: '10px',
            boxShadow:
              '0 28px 80px rgba(0, 0, 0, 0.62), inset 0 1px 0 rgba(255, 255, 255, 0.035)',
            color: wizardColors.heading,
            overflow: 'hidden',
          },
        }}
      >
        {selected && (
          <>
            <DialogTitle
              sx={{ alignItems: 'center', display: 'flex', gap: 0.5, px: 3 }}
            >
              <Typography
                component="div"
                fontSize={22}
                fontWeight={800}
                sx={{ flex: 1 }}
              >
                {t('calendar.overview', 'Overview')}
              </Typography>
              <IconButton
                aria-label={
                  shareCopied
                    ? t('calendar.copied', 'Copied')
                    : t('calendar.share', 'Share')
                }
                title={
                  shareCopied
                    ? t('calendar.copied', 'Copied')
                    : t('calendar.share', 'Share')
                }
                onClick={() => void copyEventLink(selected.eventId)}
              >
                <ShareRoundedIcon />
              </IconButton>
              {canManage && selected.occurrenceEnd > Date.now() && (
                <IconButton
                  aria-label={t('calendar.edit', 'Edit event')}
                  onClick={beginEdit}
                >
                  <EditRoundedIcon />
                </IconButton>
              )}
              {canManage && (
                <IconButton
                  color="error"
                  aria-label={t('calendar.delete', 'Delete event')}
                  onClick={() => setDeleteConfirmationOpen(true)}
                >
                  <DeleteOutlineRoundedIcon />
                </IconButton>
              )}
              <IconButton
                aria-label={t('common.close', 'Close')}
                onClick={() => setSelected(null)}
              >
                <CloseRoundedIcon />
              </IconButton>
            </DialogTitle>
            <DialogContent sx={{ maxHeight: 'min(82vh, 840px)', px: 3, pb: 3 }}>
              <Stack spacing={2}>
                <Box>
                  <Typography fontSize={14} fontWeight={750}>
                    {t('calendar.eventTitle', 'Title')}
                  </Typography>
                  <Typography
                    color={wizardColors.subtitle}
                    fontSize={13}
                    sx={{ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}
                  >
                    {selected.title}
                  </Typography>
                </Box>
                {selected.description && (
                  <Box>
                    <Typography fontSize={14} fontWeight={750}>
                      {t('calendar.description', 'Description')}
                    </Typography>
                    <Typography
                      color={wizardColors.subtitle}
                      fontSize={13}
                      sx={{ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}
                    >
                      {selected.description}
                    </Typography>
                  </Box>
                )}
                <Box>
                  <Typography fontSize={14} fontWeight={750}>
                    {t('calendar.time', 'Time')}
                  </Typography>
                  <Typography color={wizardColors.subtitle} fontSize={13}>
                    {selected.allDay
                      ? new Intl.DateTimeFormat(i18n.language, {
                          day: 'numeric',
                          month: 'long',
                          year: 'numeric',
                        }).format(selected.occurrenceStart)
                      : `${new Intl.DateTimeFormat(i18n.language, {
                          day: 'numeric',
                          hour: '2-digit',
                          hour12: false,
                          minute: '2-digit',
                          month: 'long',
                          year: 'numeric',
                        }).format(
                          selected.occurrenceStart
                        )} – ${new Intl.DateTimeFormat(i18n.language, {
                          day: 'numeric',
                          hour: '2-digit',
                          hour12: false,
                          minute: '2-digit',
                          month: 'long',
                          year: 'numeric',
                        }).format(selected.occurrenceEnd)}`}
                  </Typography>
                </Box>
                {selected.recurrence && (
                  <Box>
                    <Typography fontSize={14} fontWeight={750}>
                      {t('calendar.repeats', 'Repeats')}
                    </Typography>
                    <Typography color={wizardColors.subtitle} fontSize={13}>
                      {t(
                        `calendar.${selected.recurrence.frequency}`,
                        selected.recurrence.frequency
                      )}
                    </Typography>
                  </Box>
                )}
                {selected.location && (
                  <Box>
                    <Typography fontSize={14} fontWeight={750}>
                      {t('calendar.location', 'Location')}
                    </Typography>
                    <Typography
                      color={wizardColors.subtitle}
                      fontSize={13}
                      sx={{ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}
                    >
                      {selected.location}
                    </Typography>
                  </Box>
                )}
                {selected.link && (
                  <Box>
                    <Typography fontSize={14} fontWeight={750}>
                      {t('calendar.link', 'Link')}
                    </Typography>
                    <Button
                      component="a"
                      href={selected.link}
                      target="_blank"
                      rel="noreferrer"
                      startIcon={<LaunchRoundedIcon />}
                      sx={{
                        alignSelf: 'flex-start',
                        justifyContent: 'flex-start',
                        maxWidth: '100%',
                        minWidth: 0,
                        p: 0,
                        textTransform: 'none',
                      }}
                    >
                      <Typography
                        fontSize={13}
                        sx={{ overflow: 'hidden', textOverflow: 'ellipsis' }}
                      >
                        {selected.link}
                      </Typography>
                    </Button>
                  </Box>
                )}
                {selected.coverImage && (
                  <Box
                    sx={{
                      alignItems: 'center',
                      aspectRatio: '16 / 9',
                      bgcolor: wizardColors.field,
                      border: `1px solid ${wizardColors.border}`,
                      borderRadius: '8px',
                      display: 'flex',
                      justifyContent: 'center',
                      maxWidth: 400,
                      overflow: 'hidden',
                      width: '100%',
                    }}
                  >
                    {selectedCoverUrl ? (
                      <Box
                        alt={selected.title}
                        component="img"
                        src={selectedCoverUrl}
                        sx={{
                          display: 'block',
                          height: '100%',
                          objectFit: 'cover',
                          width: '100%',
                        }}
                      />
                    ) : selectedCoverLoading ? (
                      <CircularProgress size={24} />
                    ) : (
                      <Typography color={wizardColors.subtitle} fontSize={12}>
                        {t(
                          'calendar.coverUnavailable',
                          'Cover image unavailable'
                        )}
                      </Typography>
                    )}
                  </Box>
                )}
              </Stack>
            </DialogContent>
          </>
        )}
      </Dialog>

      <Dialog
        open={deleteConfirmationOpen}
        onClose={(_event, reason) => {
          if (reason === 'backdropClick') return;
          if (!saving) setDeleteConfirmationOpen(false);
        }}
        fullWidth
        maxWidth="sm"
        BackdropProps={{
          sx: {
            backdropFilter: 'blur(1.5px)',
            backgroundColor: 'rgba(2, 6, 12, 0.76)',
          },
        }}
        PaperProps={{
          sx: {
            bgcolor: wizardColors.modal,
            backgroundImage: wizardColors.modalGradient,
            border: `1px solid ${wizardColors.border}`,
            borderRadius: '10px',
            boxShadow:
              '0 28px 80px rgba(0, 0, 0, 0.62), inset 0 1px 0 rgba(255, 255, 255, 0.035)',
            color: wizardColors.heading,
            overflow: 'hidden',
            width: 'min(560px, calc(100vw - 32px))',
          },
        }}
      >
        <DialogTitle
          sx={{ alignItems: 'center', display: 'flex', gap: 1, px: 3, py: 2.5 }}
        >
          <Typography
            component="div"
            fontSize={22}
            fontWeight={800}
            sx={{ flex: 1 }}
          >
            {t('calendar.delete', 'Delete event')}
          </Typography>
          <IconButton
            aria-label={t('common.close', 'Close')}
            disabled={saving}
            onClick={() => setDeleteConfirmationOpen(false)}
          >
            <CloseRoundedIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent sx={{ px: 3, pb: 4, pt: 3 }}>
          <Typography color={wizardColors.label} fontSize={18} sx={{ mb: 1.5 }}>
            {t('calendar.confirmDelete', 'Delete this event series?')}
          </Typography>
          <Typography color={wizardColors.subtitle} fontSize={14}>
            {t(
              'calendar.deleteWarning',
              'This will permanently delete all occurrences of this event.'
            )}
          </Typography>
        </DialogContent>
        <DialogActions
          sx={{
            borderTop: `1px solid ${wizardColors.divider}`,
            gap: 1.5,
            justifyContent: 'flex-end',
            px: 3,
            py: 2.5,
          }}
        >
          <Button
            disabled={saving}
            onClick={() => setDeleteConfirmationOpen(false)}
            sx={{
              color: wizardColors.label,
              fontWeight: 650,
              px: 2,
              textTransform: 'uppercase',
              '&:hover': {
                bgcolor: 'transparent',
                color: wizardColors.heading,
              },
            }}
          >
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button
            disabled={saving}
            onClick={() => void remove()}
            sx={{
              backgroundColor: '#dc2626',
              borderRadius: '8px',
              color: theme.palette.common.white,
              fontWeight: 650,
              minHeight: 44,
              minWidth: 150,
              px: 2.5,
              textTransform: 'uppercase',
              '&:hover': { backgroundColor: '#b91c1c' },
              '&.Mui-disabled': {
                backgroundColor: alpha('#dc2626', 0.38),
                color: alpha(theme.palette.common.white, 0.48),
              },
            }}
          >
            {saving ? (
              <CircularProgress color="inherit" size={20} />
            ) : (
              t('calendar.delete', 'Delete event')
            )}
          </Button>
        </DialogActions>
      </Dialog>
    </Dialog>
  );
}
