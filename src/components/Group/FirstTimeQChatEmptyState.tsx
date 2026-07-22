import SearchRoundedIcon from '@mui/icons-material/SearchRounded';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import {
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  TextField,
  Typography,
} from '@mui/material';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import qortalOfficialLogo from '../../assets/sidebar/qortal-logo-official.png';
import chatBubbleDots from '../../assets/qchat/caught-up-chat-dots.png';
import chatBubbleLines from '../../assets/qchat/caught-up-chat-lines.png';
import {
  parseReticulumGroupInviteLinks,
  ReticulumGroupInvitePreviews,
} from '../Chat/ReticulumGroupInvitePreview';

const FIREFLY_POSITIONS = [
  { left: 15, top: 37 },
  { left: 42, top: 6 },
  { right: 16, top: 28 },
  { right: 40, top: 6 },
];

type FirstTimeQChatEmptyStateProps = {
  onFindCommunities: () => void;
};

export function FirstTimeQChatEmptyState({
  onFindCommunities,
}: FirstTimeQChatEmptyStateProps) {
  const [inviteLink, setInviteLink] = useState('');
  const [submittedInvite, setSubmittedInvite] = useState('');
  const [isCheckingInvite, setIsCheckingInvite] = useState(false);
  const [inviteError, setInviteError] = useState('');
  const [isWhatsNewOpen, setIsWhatsNewOpen] = useState(false);
  const logoRef = useRef<HTMLImageElement | null>(null);
  const leftBubbleRef = useRef<HTMLImageElement | null>(null);
  const rightBubbleRef = useRef<HTMLImageElement | null>(null);
  const fireflyRefs = useRef<Array<HTMLDivElement | null>>([]);

  useEffect(() => {
    const logo = logoRef.current;
    const leftBubble = leftBubbleRef.current;
    const rightBubble = rightBubbleRef.current;
    const fireflies = fireflyRefs.current.filter(
      (element): element is HTMLDivElement => Boolean(element)
    );
    if (
      !logo ||
      !leftBubble ||
      !rightBubble ||
      fireflies.length !== FIREFLY_POSITIONS.length
    )
      return;

    const animations: Animation[] = [
      logo.animate(
        [
          { transform: 'translate(-50%, 0)' },
          { transform: 'translate(-50%, -4px)' },
          { transform: 'translate(-50%, 0)' },
        ],
        {
          duration: 5000,
          easing: 'ease-in-out',
          iterations: Infinity,
        }
      ),
      leftBubble.animate(
        [
          { transform: 'translate(0, 0) rotate(-2deg)' },
          { transform: 'translate(-8px, -11px) rotate(1deg)' },
          { transform: 'translate(0, 0) rotate(-2deg)' },
        ],
        { duration: 4100, easing: 'ease-in-out', iterations: Infinity }
      ),
      rightBubble.animate(
        [
          { transform: 'translate(0, 0) rotate(2deg)' },
          { transform: 'translate(9px, -9px) rotate(-1deg)' },
          { transform: 'translate(0, 0) rotate(2deg)' },
        ],
        { duration: 4550, easing: 'ease-in-out', iterations: Infinity }
      ),
    ];

    fireflies.forEach((firefly, index) => {
      const travelsLeft = index >= 2;
      const animation = firefly.animate(
        [
          { opacity: 0.5, transform: 'translate(0, 0) scale(0.85)' },
          {
            opacity: 1,
            transform: `translate(${travelsLeft ? -6 : 6}px, ${index % 2 ? 5 : -7}px) scale(1.2)`,
          },
          {
            opacity: 0.68,
            transform: `translate(${travelsLeft ? 3 : -3}px, -4px) scale(0.95)`,
          },
          { opacity: 0.5, transform: 'translate(0, 0) scale(0.85)' },
        ],
        {
          delay: index * 180,
          duration: 2300 + index * 310,
          easing: 'ease-in-out',
          iterations: Infinity,
        }
      );
      animations.push(animation);
    });

    return () => animations.forEach((animation) => animation.cancel());
  }, []);

  const hasInvite = Boolean(inviteLink.trim());
  const submittedInviteIsValid = useMemo(
    () =>
      parseReticulumGroupInviteLinks(submittedInvite).some(
        (invite) => invite.validSyntax && invite.groupId
      ),
    [submittedInvite]
  );

  const handleInviteSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedLink = inviteLink.trim();
    if (!normalizedLink || isCheckingInvite) return;

    setIsCheckingInvite(true);
    setInviteError('');
    setSubmittedInvite('');

    window.setTimeout(() => {
      const isValid = parseReticulumGroupInviteLinks(normalizedLink).some(
        (invite) => invite.validSyntax && invite.groupId
      );
      if (isValid) {
        setSubmittedInvite(normalizedLink);
      } else {
        setInviteError(
          "This doesn't look like a valid Qortal group invite link."
        );
      }
      setIsCheckingInvite(false);
    }, 0);
  };

  return (
    <Box
      sx={{
        alignItems: 'center',
        boxSizing: 'border-box',
        display: 'flex',
        height: '100%',
        justifyContent: 'center',
        overflow: 'auto',
        position: 'relative',
        px: 3,
        py: 5,
        width: '100%',
      }}
    >
      <Button
        onClick={() => setIsWhatsNewOpen(true)}
        variant="outlined"
        sx={{
          borderColor: 'rgba(151, 161, 178, 0.35)',
          borderRadius: '8px',
          color: 'text.secondary',
          fontSize: 13,
          fontWeight: 650,
          position: 'absolute',
          right: { xs: 16, sm: 24 },
          textTransform: 'none',
          top: { xs: 16, sm: 24 },
          zIndex: 3,
          '&:hover': {
            backgroundColor: 'rgba(255, 255, 255, 0.055)',
            borderColor: 'rgba(151, 161, 178, 0.58)',
            color: 'text.primary',
          },
        }}
      >
        What's New?
      </Button>

      <Box
        sx={{
          alignItems: 'center',
          display: 'flex',
          flexDirection: 'column',
          maxWidth: 560,
          textAlign: 'center',
          width: '100%',
        }}
      >
        <Box
          aria-hidden
          sx={{
            height: 112,
            mb: 3.5,
            position: 'relative',
            width: { xs: 270, sm: 300 },
            '&::after': {
              background:
                'radial-gradient(ellipse at center, rgba(0, 161, 255, 0.42) 0%, rgba(0, 119, 255, 0.14) 38%, transparent 72%)',
              bottom: 1,
              content: '""',
              filter: 'blur(5px)',
              height: 22,
              left: '50%',
              position: 'absolute',
              transform: 'translateX(-50%)',
              width: 178,
            },
          }}
        >
          <Box
            component="img"
            data-qchat-motion="logo"
            ref={logoRef}
            src={qortalOfficialLogo}
            alt=""
            sx={{
              filter: 'drop-shadow(0 7px 15px rgba(0, 129, 255, 0.27))',
              height: { xs: 80, sm: 86 },
              left: '50%',
              position: 'absolute',
              top: 0,
              transform: 'translate(-50%, 0)',
              width: { xs: 80, sm: 86 },
              zIndex: 1,
            }}
          />
          <Box
            component="img"
            ref={leftBubbleRef}
            src={chatBubbleDots}
            alt=""
            sx={{
              filter: 'drop-shadow(0 5px 10px rgba(0, 105, 210, 0.2))',
              left: { xs: 22, sm: 31 },
              opacity: 0.68,
              position: 'absolute',
              top: 34,
              width: { xs: 54, sm: 59 },
              zIndex: 1,
            }}
          />
          <Box
            component="img"
            ref={rightBubbleRef}
            src={chatBubbleLines}
            alt=""
            sx={{
              filter: 'drop-shadow(0 5px 10px rgba(0, 105, 210, 0.2))',
              opacity: 0.68,
              position: 'absolute',
              right: { xs: 21, sm: 29 },
              top: 44,
              width: { xs: 54, sm: 59 },
              zIndex: 1,
            }}
          />
          {FIREFLY_POSITIONS.map((sparkle, index) => (
            <Box
              data-qchat-motion={`firefly-${index + 1}`}
              key={index}
              ref={(element: HTMLDivElement | null) => {
                fireflyRefs.current[index] = element;
              }}
              sx={{
                backgroundColor: '#73b9ff',
                borderRadius: '50%',
                boxShadow: '0 0 7px rgba(83, 164, 255, 0.82)',
                height: index % 2 ? 3 : 4,
                position: 'absolute',
                width: index % 2 ? 3 : 4,
                opacity: 0.75,
                zIndex: 2,
                ...sparkle,
              }}
            />
          ))}
        </Box>

        <Typography
          component="h2"
          sx={{
            color: 'text.primary',
            fontSize: { xs: 26, sm: 30 },
            fontWeight: 750,
            letterSpacing: '-0.025em',
            lineHeight: 1.18,
            mb: 1.25,
            whiteSpace: 'nowrap',
          }}
        >
          Welcome to the new, improved Q-Chat
        </Typography>
        <Typography
          sx={{
            color: 'text.secondary',
            fontSize: 15,
            lineHeight: 1.5,
            mb: 4,
          }}
        >
          Looks like you're not part of any communities yet. Let's change that.
        </Typography>

        <Button
          fullWidth
          onClick={onFindCommunities}
          startIcon={<SearchRoundedIcon sx={{ fontSize: 23 }} />}
          variant="contained"
          sx={{
            borderRadius: '10px',
            backgroundColor: '#1f75f0',
            boxShadow: '0 5px 16px rgba(31, 117, 240, 0.2)',
            color: 'common.white',
            fontSize: 16,
            fontWeight: 650,
            height: 56,
            mb: 3,
            maxWidth: 440,
            textTransform: 'none',
            transition:
              'background-color 160ms ease, box-shadow 160ms ease, transform 160ms ease',
            '& .MuiButton-startIcon': {
              color: 'inherit',
            },
            '&:hover': {
              backgroundColor: 'primary.main',
              boxShadow: '0 8px 22px rgba(31, 117, 240, 0.28)',
              transform: 'translateY(-1px)',
            },
            '&:active': {
              backgroundColor: '#1a67d8',
              boxShadow: '0 4px 12px rgba(31, 117, 240, 0.2)',
              transform: 'translateY(0)',
            },
          }}
        >
          Find Communities
        </Button>

        <Box sx={{ alignItems: 'center', color: 'text.secondary', display: 'flex', gap: 1.5, mb: 3, maxWidth: 440, width: '100%' }}>
          <Divider sx={{ borderColor: 'rgba(255,255,255,0.13)', flex: 1 }} />
          <Typography sx={{ color: 'text.secondary', fontSize: 14, fontWeight: 600 }}>
            or
          </Typography>
          <Divider sx={{ borderColor: 'rgba(255,255,255,0.13)', flex: 1 }} />
        </Box>

        <Box component="form" onSubmit={handleInviteSubmit} sx={{ maxWidth: 440, width: '100%' }}>
          <Box
            sx={{
              alignItems: 'stretch',
              backgroundColor: 'rgba(11, 14, 20, 0.72)',
              border: '1px solid rgba(151, 161, 178, 0.32)',
              borderRadius: '10px',
              display: 'flex',
              overflow: 'hidden',
              transition: 'border-color 0.15s ease',
              '&:focus-within': { borderColor: 'primary.main' },
            }}
          >
            <TextField
              aria-label="Group invite link"
              autoComplete="off"
              disabled={isCheckingInvite}
              onChange={(event) => {
                setInviteLink(event.target.value);
                if (inviteError) setInviteError('');
              }}
              placeholder="Paste a Group Invite Link..."
              value={inviteLink}
              variant="standard"
              sx={{
                flex: 1,
                minWidth: 0,
                '& .MuiInputBase-input': {
                  fontSize: 14,
                  px: 2,
                  py: 1.65,
                },
                '& .MuiInputBase-root::before, & .MuiInputBase-root::after': { display: 'none' },
              }}
            />
            <Button
              disabled={!hasInvite || isCheckingInvite}
              type="submit"
              sx={{
                borderLeft: '1px solid rgba(151, 161, 178, 0.2)',
                borderRadius: 0,
                color: 'text.primary',
                flexShrink: 0,
                fontSize: 14,
                fontWeight: 650,
                minWidth: 76,
                px: 2,
                textTransform: 'none',
              }}
            >
              {isCheckingInvite ? <CircularProgress size={18} color="inherit" /> : 'Join'}
            </Button>
          </Box>
          {inviteError && (
            <Typography role="alert" sx={{ color: '#e07a85', fontSize: 13, mt: 1, textAlign: 'left' }}>
              {inviteError}
            </Typography>
          )}
        </Box>

        {submittedInviteIsValid && (
          <Box
            sx={{
              alignItems: 'center',
              display: 'flex',
              flexDirection: 'column',
              mt: 1.25,
              textAlign: 'left',
              width: '100%',
            }}
          >
            <ReticulumGroupInvitePreviews source={submittedInvite} />
          </Box>
        )}
      </Box>

      <Dialog
        fullWidth
        maxWidth="sm"
        onClose={() => setIsWhatsNewOpen(false)}
        open={isWhatsNewOpen}
        PaperProps={{
          sx: {
            backgroundColor: '#1D2028',
            backgroundImage: 'none',
            border: '1px solid rgba(255, 255, 255, 0.13)',
            borderRadius: '12px',
            boxShadow: '0 24px 70px rgba(0, 0, 0, 0.45)',
            minHeight: 360,
          },
        }}
      >
        <DialogTitle
          sx={{
            alignItems: 'center',
            display: 'flex',
            fontSize: 24,
            fontWeight: 750,
            justifyContent: 'space-between',
            lineHeight: 1.2,
            px: 3,
            py: 2.5,
          }}
        >
          What's New?
          <IconButton
            aria-label="Close What's New"
            onClick={() => setIsWhatsNewOpen(false)}
            size="small"
            sx={{ color: 'text.secondary' }}
          >
            <CloseRoundedIcon />
          </IconButton>
        </DialogTitle>
        <Divider sx={{ borderColor: 'rgba(255, 255, 255, 0.08)' }} />
        <DialogContent />
      </Dialog>
    </Box>
  );
}
