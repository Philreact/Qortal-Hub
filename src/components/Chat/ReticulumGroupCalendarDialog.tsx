import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
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
import AddRoundedIcon from '@mui/icons-material/AddRounded';
import ChevronLeftRoundedIcon from '@mui/icons-material/ChevronLeftRounded';
import ChevronRightRoundedIcon from '@mui/icons-material/ChevronRightRounded';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded';
import EditRoundedIcon from '@mui/icons-material/EditRounded';
import EventRoundedIcon from '@mui/icons-material/EventRounded';
import LaunchRoundedIcon from '@mui/icons-material/LaunchRounded';
import moment from 'moment-timezone';
import { useTranslation } from 'react-i18next';

type Props = {
  open: boolean;
  groupId: number;
  ownerAddress: string;
  canManage: boolean;
  targetEventId?: string;
  targetOccurrenceStart?: number;
  targetTimezone?: string;
  onClose: () => void;
};

type FormState = ReticulumCalendarEventInput & {
  recurrenceFrequency: '' | 'daily' | 'weekly' | 'monthly' | 'yearly';
  recurrenceUntil: string;
};

const reminderOptions = [
  { value: '', label: 'None' },
  { value: '0', label: 'At start' },
  { value: String(10 * 60_000), label: '10 minutes before' },
  { value: String(30 * 60_000), label: '30 minutes before' },
  { value: String(60 * 60_000), label: '1 hour before' },
  { value: String(24 * 60 * 60_000), label: '1 day before' },
];

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
    description: event?.description || '',
    location: event?.location || '',
    link: event?.link || '',
    allDay: event?.allDay || false,
    timezone,
    startLocal: start,
    endLocal: end,
    recurrence: null,
    recurrenceFrequency: event?.recurrence?.frequency || '',
    recurrenceUntil: event?.recurrence?.untilLocalDate || '',
  };
};

const inputValue = (value: string, allDay: boolean): string =>
  allDay ? value.slice(0, 10) : value.slice(0, 16);

export function ReticulumGroupCalendarDialog({
  open,
  groupId,
  ownerAddress,
  canManage,
  targetEventId = '',
  targetOccurrenceStart = 0,
  targetTimezone = '',
  onClose,
}: Props) {
  const { t, i18n } = useTranslation();
  const theme = useTheme();
  const narrow = useMediaQuery(theme.breakpoints.down('md'));
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
  const [form, setForm] = useState<FormState>(() => createForm());
  const [saving, setSaving] = useState(false);
  const [reminder, setReminder] = useState('');
  const [deleteConfirmationOpen, setDeleteConfirmationOpen] = useState(false);

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
    if (!open) return;
    return window.reticulumChat?.onCalendarChanged?.((payload) => {
      if (payload.groupId === groupId) void load();
    });
  }, [groupId, load, open]);

  useEffect(() => {
    if (!selected || !ownerAddress) {
      setReminder('');
      return;
    }
    let active = true;
    void window.reticulumChat
      ?.getCalendarReminder?.(ownerAddress, groupId, selected.eventId)
      .then((value) => {
        if (active)
          setReminder(value?.offsetMs == null ? '' : String(value.offsetMs));
      })
      .catch(() => {
        if (active) setReminder('');
      });
    return () => {
      active = false;
    };
  }, [groupId, ownerAddress, selected]);

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

  const agenda = eventsByDay.get(selectedDate) || [];

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
    const next = createForm();
    next.startLocal = `${selectedDate}T${moment().add(1, 'hour').startOf('hour').format('HH:mm')}:00`;
    next.endLocal = `${selectedDate}T${moment().add(2, 'hours').startOf('hour').format('HH:mm')}:00`;
    setSelected(null);
    setForm(next);
    setEditing(true);
  };

  const beginEdit = () => {
    if (!selected) return;
    setForm(createForm(selected));
    setEditing(true);
  };

  const submit = async () => {
    if (!window.reticulumChat || !form.title.trim()) return;
    setSaving(true);
    setError('');
    const input: ReticulumCalendarEventInput = {
      title: form.title,
      description: form.description,
      location: form.location,
      link: form.link,
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
    try {
      if (selected) {
        await window.reticulumChat.updateCalendarEvent(
          groupId,
          selected.eventId,
          input
        );
      } else {
        await window.reticulumChat.createCalendarEvent(groupId, input);
      }
      setEditing(false);
      await load();
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

  const changeReminder = async (value: string) => {
    if (!selected || !ownerAddress) return;
    const previous = reminder;
    setReminder(value);
    try {
      await window.reticulumChat?.setCalendarReminder?.(
        ownerAddress,
        groupId,
        selected.eventId,
        value === '' ? null : Number(value)
      );
    } catch (reason) {
      setReminder(previous);
      setError(reason instanceof Error ? reason.message : String(reason));
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
          height: narrow ? '100%' : 'min(820px, 88vh)',
        },
      }}
    >
      <DialogTitle sx={{ alignItems: 'center', display: 'flex', gap: 1 }}>
        <EventRoundedIcon color="primary" />
        <Box sx={{ flex: 1 }}>
          <Typography component="div" fontSize={18} fontWeight={800}>
            {t('calendar.title', 'Group Calendar')}
          </Typography>
          <Typography color="text.secondary" fontSize={12}>
            {t('calendar.subtitle', 'Events shared with this group')}
          </Typography>
        </Box>
        {canManage && (
          <Button startIcon={<AddRoundedIcon />} onClick={beginAdd}>
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
              borderRight: narrow ? 0 : `1px solid ${theme.palette.divider}`,
              display: 'flex',
              flexDirection: 'column',
              minHeight: 0,
              p: 2,
            }}
          >
            <Box sx={{ alignItems: 'center', display: 'flex', mb: 1 }}>
              <IconButton
                aria-label="Previous month"
                onClick={() => moveMonth(-1)}
              >
                <ChevronLeftRoundedIcon />
              </IconButton>
              <Typography
                sx={{
                  flex: 1,
                  fontSize: 18,
                  fontWeight: 800,
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
              <IconButton aria-label="Next month" onClick={() => moveMonth(1)}>
                <ChevronRightRoundedIcon />
              </IconButton>
            </Box>
            <Box
              sx={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)' }}
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
                        day.month() === month.month()
                          ? 'text.primary'
                          : 'text.disabled',
                      display: 'flex',
                      flexDirection: 'column',
                      justifyContent: 'flex-start',
                      minHeight: { xs: 64, md: 82 },
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
                            borderLeft: `2px solid ${theme.palette.primary.main}`,
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
              display: 'flex',
              flexDirection: 'column',
              minHeight: 280,
              overflow: 'auto',
              p: 2,
            }}
          >
            <Typography fontSize={16} fontWeight={800}>
              {new Intl.DateTimeFormat(i18n.language, {
                weekday: 'long',
                month: 'long',
                day: 'numeric',
              }).format(moment(selectedDate).toDate())}
            </Typography>
            <Typography color="text.secondary" fontSize={12} sx={{ mb: 2 }}>
              {agenda.length
                ? t('calendar.eventCount', '{{count}} events', {
                    count: agenda.length,
                  })
                : t('calendar.noEvents', 'No events')}
            </Typography>
            {loading ? (
              <Box sx={{ display: 'grid', flex: 1, placeItems: 'center' }}>
                <CircularProgress size={28} />
              </Box>
            ) : (
              agenda.map((event) => (
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
                  }}
                >
                  <Typography fontWeight={750}>{event.title}</Typography>
                  <Typography color="text.secondary" fontSize={12}>
                    {event.allDay
                      ? t('calendar.allDay', 'All day')
                      : moment(event.occurrenceStart)
                          .tz(event.timezone)
                          .format('LT')}{' '}
                    · {event.location || event.timezone}
                  </Typography>
                </Button>
              ))
            )}
          </Box>
        </Box>
      </DialogContent>

      <Dialog
        open={editing}
        onClose={() => !saving && setEditing(false)}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>
          {selected
            ? t('calendar.edit', 'Edit event')
            : t('calendar.add', 'Add event')}
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <TextField
              autoFocus
              label={t('calendar.eventTitle', 'Title')}
              inputProps={{ maxLength: 120 }}
              value={form.title}
              onChange={(e) =>
                setForm((v) => ({ ...v, title: e.target.value }))
              }
            />
            <TextField
              label={t('calendar.description', 'Description')}
              multiline
              minRows={3}
              inputProps={{ maxLength: 4000 }}
              value={form.description}
              onChange={(e) =>
                setForm((v) => ({ ...v, description: e.target.value }))
              }
            />
            <TextField
              select
              label={t('calendar.type', 'Time')}
              value={form.allDay ? 'all-day' : 'timed'}
              onChange={(e) =>
                setForm((value) => {
                  const allDay = e.target.value === 'all-day';
                  const sameDate =
                    value.startLocal.slice(0, 10) ===
                    value.endLocal.slice(0, 10);
                  return {
                    ...value,
                    allDay,
                    ...(allDay && sameDate
                      ? {
                          endLocal: moment(value.startLocal.slice(0, 10))
                            .add(1, 'day')
                            .format('YYYY-MM-DD'),
                        }
                      : {}),
                  };
                })
              }
            >
              <MenuItem value="timed">{t('calendar.timed', 'Timed')}</MenuItem>
              <MenuItem value="all-day">
                {t('calendar.allDay', 'All day')}
              </MenuItem>
            </TextField>
            <Stack direction={narrow ? 'column' : 'row'} spacing={2}>
              <TextField
                fullWidth
                type={form.allDay ? 'date' : 'datetime-local'}
                label={t('calendar.starts', 'Starts')}
                InputLabelProps={{ shrink: true }}
                value={inputValue(form.startLocal, form.allDay)}
                onChange={(e) =>
                  setForm((v) => ({ ...v, startLocal: e.target.value }))
                }
              />
              <TextField
                fullWidth
                type={form.allDay ? 'date' : 'datetime-local'}
                label={t('calendar.ends', 'Ends')}
                InputLabelProps={{ shrink: true }}
                value={inputValue(form.endLocal, form.allDay)}
                onChange={(e) =>
                  setForm((v) => ({ ...v, endLocal: e.target.value }))
                }
              />
            </Stack>
            <TextField
              label={t('calendar.timezone', 'Time zone')}
              value={form.timezone}
              InputProps={{ readOnly: true }}
              helperText={t(
                'calendar.timezoneHelp',
                'Event times use this time zone.'
              )}
            />
            <TextField
              select
              label={t('calendar.repeats', 'Repeats')}
              value={form.recurrenceFrequency}
              onChange={(e) =>
                setForm((v) => ({
                  ...v,
                  recurrenceFrequency: e.target
                    .value as FormState['recurrenceFrequency'],
                }))
              }
            >
              <MenuItem value="">{t('calendar.never', 'Never')}</MenuItem>
              <MenuItem value="daily">{t('calendar.daily', 'Daily')}</MenuItem>
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
                value={form.recurrenceUntil}
                onChange={(e) =>
                  setForm((v) => ({ ...v, recurrenceUntil: e.target.value }))
                }
              />
            )}
            <TextField
              label={t('calendar.location', 'Location')}
              inputProps={{ maxLength: 240 }}
              value={form.location}
              onChange={(e) =>
                setForm((v) => ({ ...v, location: e.target.value }))
              }
            />
            <TextField
              label={t('calendar.link', 'Link')}
              inputProps={{ maxLength: 2048 }}
              value={form.link}
              onChange={(e) => setForm((v) => ({ ...v, link: e.target.value }))}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditing(false)} disabled={saving}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button
            variant="contained"
            onClick={() => void submit()}
            disabled={saving || !form.title.trim()}
          >
            {saving ? <CircularProgress size={20} /> : t('common.save', 'Save')}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={Boolean(selected) && !editing}
        onClose={() => setSelected(null)}
        fullWidth
        maxWidth="sm"
      >
        {selected && (
          <>
            <DialogTitle sx={{ display: 'flex', gap: 1 }}>
              <Box sx={{ flex: 1 }}>{selected.title}</Box>
              {canManage && (
                <>
                  <IconButton
                    aria-label={t('calendar.edit', 'Edit event')}
                    onClick={beginEdit}
                  >
                    <EditRoundedIcon />
                  </IconButton>
                  <IconButton
                    color="error"
                    aria-label={t('calendar.delete', 'Delete event')}
                    onClick={() => setDeleteConfirmationOpen(true)}
                  >
                    <DeleteOutlineRoundedIcon />
                  </IconButton>
                </>
              )}
              <IconButton
                aria-label={t('common.close', 'Close')}
                onClick={() => setSelected(null)}
              >
                <CloseRoundedIcon />
              </IconButton>
            </DialogTitle>
            <DialogContent>
              <Stack spacing={2}>
                {selected.recurrence && (
                  <Chip
                    size="small"
                    label={`${t('calendar.repeats', 'Repeats')}: ${t(
                      `calendar.${selected.recurrence.frequency}`,
                      selected.recurrence.frequency
                    )}`}
                    sx={{ alignSelf: 'flex-start' }}
                  />
                )}
                <Typography>
                  {selected.allDay
                    ? moment(selected.occurrenceStart)
                        .tz(selected.timezone)
                        .format('LL')
                    : `${moment(selected.occurrenceStart).tz(selected.timezone).format('LLLL')} – ${moment(selected.occurrenceEnd).tz(selected.timezone).format('LT')}`}
                </Typography>
                {selected.description && (
                  <Typography sx={{ whiteSpace: 'pre-wrap' }}>
                    {selected.description}
                  </Typography>
                )}
                {selected.location && (
                  <Typography color="text.secondary">
                    {selected.location}
                  </Typography>
                )}
                {selected.link && (
                  <Button
                    component="a"
                    href={selected.link}
                    target="_blank"
                    rel="noreferrer"
                    startIcon={<LaunchRoundedIcon />}
                    sx={{ alignSelf: 'flex-start' }}
                  >
                    {t('calendar.openLink', 'Open link')}
                  </Button>
                )}
                <TextField
                  select
                  size="small"
                  label={t('calendar.reminder', 'Reminder')}
                  value={reminder}
                  onChange={(e) => void changeReminder(e.target.value)}
                >
                  {reminderOptions.map((option) => (
                    <MenuItem key={option.value} value={option.value}>
                      {t(
                        `calendar.reminder${option.value || 'None'}`,
                        option.label
                      )}
                    </MenuItem>
                  ))}
                </TextField>
              </Stack>
            </DialogContent>
          </>
        )}
      </Dialog>

      <Dialog
        open={deleteConfirmationOpen}
        onClose={() => !saving && setDeleteConfirmationOpen(false)}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle>{t('calendar.delete', 'Delete event')}</DialogTitle>
        <DialogContent>
          <Typography color="text.secondary">
            {t('calendar.confirmDelete', 'Delete this event series?')}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button
            disabled={saving}
            onClick={() => setDeleteConfirmationOpen(false)}
          >
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button
            color="error"
            disabled={saving}
            variant="contained"
            onClick={() => void remove()}
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
