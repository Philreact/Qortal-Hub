import { useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Typography,
} from '@mui/material';

type CaptureResult = {
  success: boolean;
  error?: string;
  durationMs?: number;
  profilePath?: string;
  sampleCount?: number;
  hotspots?: Array<{ label: string; samples: number }>;
  metrics?: ReticulumRuntimeMetrics;
};

export type ReticulumRuntimeMetrics = {
  chatGroupRenders: number;
  parentRendersWithStableProps: number;
  parentPropChanges: Record<string, number>;
  queuedMessageUpdates: number;
  reticulumEventListUpdates: number;
  visibleMessageUpdates: number;
  visibleReticulumEvents: number;
};

type ReticulumDiagnosticsDialogProps = {
  open: boolean;
  onClose: () => void;
  onCaptureStart?: () => void;
  getRuntimeMetrics?: () => ReticulumRuntimeMetrics;
};

const PROFILE_DURATION_MS = 10_000;

export function ReticulumDiagnosticsDialog({
  open,
  onClose,
  onCaptureStart,
  getRuntimeMetrics,
}: ReticulumDiagnosticsDialogProps) {
  const [capturing, setCapturing] = useState(false);
  const [result, setResult] = useState<CaptureResult | null>(null);

  const report = useMemo(() => {
    if (!result?.success) return '';
    const hotspots = (result.hotspots || [])
      .map((hotspot) => hotspot.samples + '\t' + hotspot.label)
      .join('\n');
    const metrics = result.metrics
      ? [
          '',
          'Reticulum render counters during capture',
          'ChatGroup renders: ' + result.metrics.chatGroupRenders,
          'Parent renders with no ChatGroup prop changes: ' +
            result.metrics.parentRendersWithStableProps,
          'Changed ChatGroup props: ' +
            (Object.entries(result.metrics.parentPropChanges)
              .filter(([, count]) => count > 0)
              .map(([name, count]) => `${name}=${count}`)
              .join(', ') || 'none'),
          'Reticulum event-list updates: ' +
            result.metrics.reticulumEventListUpdates,
          'Visible-message updates: ' + result.metrics.visibleMessageUpdates,
          'Queued-message updates: ' + result.metrics.queuedMessageUpdates,
          'Visible Reticulum events: ' + result.metrics.visibleReticulumEvents,
        ]
      : [];
    return [
      'Reticulum renderer CPU profile (' +
        (result.durationMs || PROFILE_DURATION_MS) +
        ' ms)',
      'Samples: ' + (result.sampleCount || 0),
      'Raw profile: ' + (result.profilePath || ''),
      '',
      hotspots,
      ...metrics,
    ].join('\n');
  }, [result]);

  const capture = async () => {
    if (!window.reticulumDiagnostics?.captureRendererCpuProfile) {
      setResult({
        success: false,
        error: 'Reticulum diagnostics is unavailable in this build.',
      });
      return;
    }
    onCaptureStart?.();
    setCapturing(true);
    setResult(null);
    try {
      const captureResult =
        await window.reticulumDiagnostics.captureRendererCpuProfile(
          PROFILE_DURATION_MS
        );
      setResult({
        ...captureResult,
        metrics: getRuntimeMetrics?.(),
      });
    } catch (error) {
      setResult({
        success: false,
        error:
          error instanceof Error
            ? error.message
            : 'Renderer CPU capture failed.',
      });
    } finally {
      setCapturing(false);
    }
  };

  const copyReport = async () => {
    if (!report || !navigator.clipboard) return;
    await navigator.clipboard.writeText(report);
  };

  return (
    <Dialog
      fullWidth
      maxWidth="sm"
      onClose={capturing ? undefined : onClose}
      open={open}
    >
      <DialogTitle>Reticulum diagnostics</DialogTitle>
      <DialogContent dividers>
        <Typography color="text.secondary" variant="body2">
          This is an on-demand local CPU capture for the current Hub renderer.
          It does not run in the background and does not change Reticulum data.
        </Typography>
        <Button
          disabled={capturing}
          onClick={capture}
          sx={{ mt: 2 }}
          variant="contained"
        >
          {capturing
            ? 'Capturing 10-second profile…'
            : 'Capture 10-second CPU profile'}
        </Button>

        {result && !result.success && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {result.error || 'Renderer CPU capture failed.'}
          </Alert>
        )}

        {result?.success && (
          <Box sx={{ mt: 2 }}>
            <Alert severity="success">
              Captured {result.sampleCount || 0} samples. The raw profile was
              saved locally.
            </Alert>
            <Typography sx={{ mt: 2 }} variant="caption">
              {result.profilePath}
            </Typography>
            <Divider sx={{ my: 2 }} />
            <Typography fontWeight={700} variant="subtitle2">
              Hottest sampled functions
            </Typography>
            <Box
              component="pre"
              sx={{
                fontFamily: 'monospace',
                fontSize: 12,
                m: 0,
                mt: 1,
                overflow: 'auto',
                whiteSpace: 'pre-wrap',
              }}
            >
              {(result.hotspots || [])
                .map(
                  (hotspot) =>
                    hotspot.samples.toString().padStart(5) +
                    '  ' +
                    hotspot.label
                )
                .join('\n') || 'No JavaScript samples were recorded.'}
            </Box>
            <Typography color="text.secondary" sx={{ mt: 2 }} variant="caption">
              Production labels are minified. The raw profile records the exact
              call tree for later comparison; source maps can map it to source
              files if we choose to enable them separately.
            </Typography>
            {result.metrics && (
              <Box sx={{ mt: 2 }}>
                <Typography fontWeight={700} variant="subtitle2">
                  Reticulum render counters during capture
                </Typography>
                <Typography
                  component="div"
                  sx={{ fontFamily: 'monospace', fontSize: 12, mt: 1 }}
                >
                  ChatGroup renders: {result.metrics.chatGroupRenders}
                  <br />
                  Parent renders with no ChatGroup prop changes:{' '}
                  {result.metrics.parentRendersWithStableProps}
                  <br />
                  Changed ChatGroup props:{' '}
                  {Object.entries(result.metrics.parentPropChanges)
                    .filter(([, count]) => count > 0)
                    .map(([name, count]) => `${name}=${count}`)
                    .join(', ') || 'none'}
                  <br />
                  Reticulum event-list updates:{' '}
                  {result.metrics.reticulumEventListUpdates}
                  <br />
                  Visible-message updates: {result.metrics.visibleMessageUpdates}
                  <br />
                  Queued-message updates: {result.metrics.queuedMessageUpdates}
                  <br />
                  Visible Reticulum events: {result.metrics.visibleReticulumEvents}
                </Typography>
              </Box>
            )}
          </Box>
        )}
      </DialogContent>
      <DialogActions>
        {result?.success && <Button onClick={copyReport}>Copy report</Button>}
        <Button disabled={capturing} onClick={onClose}>
          Close
        </Button>
      </DialogActions>
    </Dialog>
  );
}
