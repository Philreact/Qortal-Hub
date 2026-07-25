import ArrowCircleUpRoundedIcon from '@mui/icons-material/ArrowCircleUpRounded';
import ImageOutlinedIcon from '@mui/icons-material/ImageOutlined';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import {
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogContent,
  Typography,
  useTheme,
} from '@mui/material';
import { alpha } from '@mui/material/styles';

type ReticulumLargeImageDialogProps = {
  fileSize: string;
  loading: boolean;
  onClose: () => void;
  onCompress: () => void;
  onUseAsAttachment: () => void;
  open: boolean;
};

export const ReticulumLargeImageDialog = ({
  fileSize,
  loading,
  onClose,
  onCompress,
  onUseAsAttachment,
  open,
}: ReticulumLargeImageDialogProps) => {
  const theme = useTheme();
  const isDark = theme.palette.mode === 'dark';
  const surfaceColor = isDark ? '#171a22' : theme.palette.background.paper;
  const borderColor = isDark
    ? alpha('#91a4bf', 0.28)
    : theme.palette.divider;
  const mutedColor = isDark
    ? alpha('#d9e2ef', 0.66)
    : theme.palette.text.secondary;

  return (
    <Dialog
      aria-labelledby="reticulum-large-image-dialog-title"
      open={open}
      onClose={loading ? undefined : onClose}
      fullWidth
      maxWidth="xs"
      PaperProps={{
        sx: {
          backgroundColor: surfaceColor,
          backgroundImage: 'none',
          border: `1px solid ${borderColor}`,
          borderRadius: '10px',
          boxShadow: isDark
            ? '0 18px 48px rgba(0, 0, 0, 0.48)'
            : '0 18px 48px rgba(15, 23, 42, 0.2)',
          boxSizing: 'border-box',
          m: 2,
          maxWidth: 'min(480px, calc(100vw - 32px))',
          overflow: 'hidden',
          width: '100%',
        },
      }}
      slotProps={{
        backdrop: {
          sx: {
            backgroundColor: isDark
              ? 'rgba(3, 6, 12, 0.72)'
              : 'rgba(15, 23, 42, 0.46)',
          },
        },
      }}
    >
      <DialogContent
        sx={{
          display: 'flex',
          flexDirection: 'column',
          gap: 0,
          p: { xs: 2.5, sm: 3.25 },
        }}
      >
        <Box
          sx={{
            alignItems: 'center',
            display: 'grid',
            gap: 2,
            gridTemplateColumns: '48px minmax(0, auto) minmax(24px, 1fr)',
          }}
        >
          <Box
            aria-hidden
            sx={{
              alignItems: 'center',
              backgroundColor: isDark
                ? alpha(theme.palette.primary.main, 0.08)
                : alpha(theme.palette.primary.main, 0.06),
              border: `1px solid ${borderColor}`,
              borderRadius: '8px',
              color: theme.palette.primary.main,
              display: 'flex',
              height: 46,
              justifyContent: 'center',
              position: 'relative',
              width: 46,
            }}
          >
            <ImageOutlinedIcon sx={{ fontSize: 27 }} />
            <ArrowCircleUpRoundedIcon
              sx={{
                backgroundColor: surfaceColor,
                borderRadius: '50%',
                bottom: 4,
                fontSize: 17,
                position: 'absolute',
                right: 3,
              }}
            />
          </Box>

          <Typography
            component="h2"
            id="reticulum-large-image-dialog-title"
            sx={{
              color: isDark ? '#f5f7fb' : theme.palette.text.primary,
              fontSize: { xs: 18, sm: 19 },
              fontWeight: 700,
              letterSpacing: '-0.015em',
              lineHeight: 1.25,
              whiteSpace: 'nowrap',
            }}
          >
            Send large image
          </Typography>

          <Box
            aria-hidden
            sx={{
              borderTop: `1px solid ${borderColor}`,
              minWidth: 24,
              width: '100%',
            }}
          />
        </Box>

        <Box sx={{ mt: 3 }}>
          <Typography
            sx={{
              color: isDark ? '#f5f7fb' : theme.palette.text.primary,
              fontSize: 14,
              fontWeight: 600,
              lineHeight: 1.45,
            }}
          >
            This image is{' '}
            <Box
              component="span"
              sx={{ color: theme.palette.primary.light, fontWeight: 700 }}
            >
              {fileSize}
            </Box>
            .
          </Typography>
          <Typography
            sx={{
              color: mutedColor,
              fontSize: 13,
              lineHeight: 1.55,
              mt: 1,
              maxWidth: 395,
            }}
          >
            Compress it for inline chat display, or send the original image as a
            downloadable attachment.
          </Typography>
        </Box>

        <Box
          sx={{
            alignItems: 'center',
            borderTop: `1px solid ${borderColor}`,
            color: mutedColor,
            display: 'flex',
            gap: 1,
            mt: 2.75,
            pt: 2,
          }}
        >
          <InfoOutlinedIcon sx={{ flexShrink: 0, fontSize: 18 }} />
          <Typography sx={{ fontSize: 12.5, lineHeight: 1.45 }}>
            Compressed images are easier on the network.
          </Typography>
        </Box>

        <Box
          sx={{
            alignItems: 'center',
            display: 'flex',
            flexWrap: 'wrap',
            gap: 1.25,
            justifyContent: 'flex-end',
            mt: 3,
          }}
        >
          <Button
            disabled={loading}
            onClick={onUseAsAttachment}
            sx={{
              borderRadius: '8px',
              color: theme.palette.primary.light,
              fontSize: 13,
              fontWeight: 700,
              minHeight: 38,
              px: 1.75,
              textTransform: 'uppercase',
              '&:hover': {
                backgroundColor: alpha(theme.palette.primary.main, 0.1),
              },
            }}
          >
            As attachment
          </Button>
          <Button
            autoFocus
            disabled={loading}
            onClick={onCompress}
            variant="contained"
            sx={{
              borderRadius: '8px',
              boxShadow: 'none',
              fontSize: 13,
              fontWeight: 700,
              minHeight: 38,
              minWidth: 112,
              px: 2.25,
              textTransform: 'uppercase',
              '&:hover': {
                boxShadow: 'none',
                filter: 'brightness(1.08)',
              },
              '&:active': {
                filter: 'brightness(0.96)',
              },
              '&:focus-visible': {
                outline: `2px solid ${alpha(theme.palette.primary.light, 0.9)}`,
                outlineOffset: 2,
              },
            }}
          >
            {loading ? (
              <>
                <CircularProgress
                  color="inherit"
                  size={15}
                  sx={{ mr: 1 }}
                />
                Compressing
              </>
            ) : (
              'Compress'
            )}
          </Button>
        </Box>
      </DialogContent>
    </Dialog>
  );
};
