import AutoDeleteRoundedIcon from '@mui/icons-material/AutoDeleteRounded';
import BoltRoundedIcon from '@mui/icons-material/BoltRounded';
import CallRoundedIcon from '@mui/icons-material/CallRounded';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import FavoriteRoundedIcon from '@mui/icons-material/FavoriteRounded';
import ForumRoundedIcon from '@mui/icons-material/ForumRounded';
import GroupsRoundedIcon from '@mui/icons-material/GroupsRounded';
import HubRoundedIcon from '@mui/icons-material/HubRounded';
import LeaderboardRoundedIcon from '@mui/icons-material/LeaderboardRounded';
import SportsEsportsRoundedIcon from '@mui/icons-material/SportsEsportsRounded';
import StarRoundedIcon from '@mui/icons-material/StarRounded';
import {
  Box,
  Dialog,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  Typography,
  useTheme,
} from '@mui/material';
import type { ReactNode } from 'react';
import reticulumQChat2026 from '../../assets/qchat/reticulum-qchat-2026.png';

type QChatWhatsNewDialogProps = {
  onClose: () => void;
  open: boolean;
};

type ReleaseHighlight = {
  description: string;
  icon: ReactNode;
  title: string;
};

const RELEASE_HIGHLIGHTS: ReleaseHighlight[] = [
  {
    icon: <HubRoundedIcon />,
    title: 'A faster chat network',
    description:
      'Q-Chat now uses Reticulum for its real-time conversations while keeping Qortal identities and group membership at the center. Messages feel immediate, dependable, and at home inside the Hub.',
  },
  {
    icon: <ForumRoundedIcon />,
    title: 'One community, many conversations',
    description:
      'Groups can organize discussion into channels and categories. There is no longer a need to create a separate group for every subject.',
  },
  {
    icon: <AutoDeleteRoundedIcon />,
    title: 'Messages on your terms',
    description:
      'Choose how long messages should remain, from 24 hours to one week, or keep them with no expiry. Replies, mentions, attachments, editing, and richer message tools make everyday chat easier.',
  },
  {
    icon: <CallRoundedIcon />,
    title: 'Calls that stay out of the way',
    description:
      'Start one-to-one and group calls without leaving Q-Chat. Group calls support up to 15 people and begin in a compact view that can be expanded whenever you need it.',
  },
  {
    icon: <SportsEsportsRoundedIcon />,
    title: 'Introducing QortalLand',
    description:
      'Enter a new shared social space where you can meet other members, use moods and proximity voice, and challenge people to Chess, Checkers, or Qonnect Four, all from inside your community.',
  },
  {
    icon: <LeaderboardRoundedIcon />,
    title: 'Discover communities with context',
    description:
      'The new Group Score brings holdings, activity, history, and community size into one clear 0–100 score, helping active public groups stand out in Find Groups and invitations.',
  },
];

const COMPARISON_ROWS = [
  {
    area: 'Message transport',
    legacy: 'Chat messages recorded through Qortal transactions',
    reticulum: 'Fast, real-time Reticulum conversations',
  },
  {
    area: 'Organization',
    legacy: 'A group generally centered on one conversation',
    reticulum: 'Channels and categories inside the same group',
  },
  {
    area: 'Live communication',
    legacy: 'Focused on durable text chat',
    reticulum: 'Text, mentions, direct chat, calls, and proximity voice',
  },
  {
    area: 'Community discovery',
    legacy: 'Member count and established group information',
    reticulum: 'Search, practical filters, previews, and Group Score',
  },
];

export function QChatWhatsNewDialog({
  onClose,
  open,
}: QChatWhatsNewDialogProps) {
  const theme = useTheme();

  return (
    <Dialog
      fullWidth
      maxWidth="md"
      onClose={onClose}
      open={open}
      PaperProps={{
        sx: {
          backgroundColor: theme.palette.background.paper,
          backgroundImage: 'none',
          border: '1px solid',
          borderColor: 'divider',
          borderRadius: '12px',
          boxShadow: '0 24px 70px rgba(0, 0, 0, 0.45)',
          maxHeight: 'min(780px, calc(100vh - 64px))',
          overflow: 'hidden',
        },
      }}
    >
      <DialogTitle
        sx={{
          alignItems: 'center',
          display: 'flex',
          justifyContent: 'space-between',
          px: { xs: 2.5, sm: 3.5 },
          py: 2.5,
        }}
      >
        <Box>
          <Typography
            component="h2"
            sx={{ fontSize: 26, fontWeight: 750, lineHeight: 1.2 }}
          >
            What&apos;s new in Q-Chat
          </Typography>
          <Typography
            sx={{
              color: 'text.secondary',
              fontSize: 13,
              fontWeight: 600,
              mt: 0.5,
            }}
          >
            Version 3.0.0
          </Typography>
        </Box>
        <IconButton
          aria-label="Close What's New"
          onClick={onClose}
          size="small"
          sx={{ color: 'text.secondary' }}
        >
          <CloseRoundedIcon />
        </IconButton>
      </DialogTitle>

      <Divider />

      <DialogContent
        sx={{
          px: { xs: 2.5, sm: 3.5 },
          py: 3,
          scrollbarColor: `${theme.palette.action.selected} transparent`,
        }}
      >
        <Box
          sx={{
            background:
              'linear-gradient(135deg, rgba(22, 139, 255, 0.14), rgba(15, 23, 42, 0.08))',
            border: '1px solid rgba(80, 165, 255, 0.24)',
            borderRadius: '10px',
            mb: 3,
            px: { xs: 2, sm: 2.5 },
            py: 2.25,
          }}
        >
          <Box sx={{ alignItems: 'center', display: 'flex', gap: 1 }}>
            <BoltRoundedIcon sx={{ color: '#52a8ff', fontSize: 22 }} />
            <Typography sx={{ fontSize: 18, fontWeight: 700 }}>
              A new foundation for Qortal conversations
            </Typography>
          </Box>
          <Typography
            sx={{
              color: 'text.secondary',
              fontSize: 14,
              lineHeight: 1.65,
              mt: 1,
              maxWidth: 680,
            }}
          >
            This release combines Qortal&apos;s community identity with the
            speed of Reticulum. It is a substantial evolution of Q-Chat: quicker
            to use, easier to organize, and built for richer ways to spend time
            together.
          </Typography>
        </Box>

        <Typography sx={{ fontSize: 17, fontWeight: 700, mb: 1.5 }}>
          Highlights
        </Typography>
        <Box
          sx={{
            display: 'grid',
            gap: 1.25,
            gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))' },
          }}
        >
          {RELEASE_HIGHLIGHTS.map((item) => (
            <Box
              key={item.title}
              sx={{
                backgroundColor: 'action.hover',
                border: '1px solid',
                borderColor: 'divider',
                borderRadius: '9px',
                display: 'flex',
                gap: 1.5,
                p: 1.75,
              }}
            >
              <Box
                sx={{
                  alignItems: 'center',
                  backgroundColor: 'rgba(22, 139, 255, 0.12)',
                  borderRadius: '8px',
                  color: '#52a8ff',
                  display: 'flex',
                  flex: '0 0 auto',
                  height: 36,
                  justifyContent: 'center',
                  width: 36,
                  '& svg': { fontSize: 20 },
                }}
              >
                {item.icon}
              </Box>
              <Box>
                <Typography sx={{ fontSize: 14.5, fontWeight: 700 }}>
                  {item.title}
                </Typography>
                <Typography
                  sx={{
                    color: 'text.secondary',
                    fontSize: 13,
                    lineHeight: 1.55,
                    mt: 0.5,
                  }}
                >
                  {item.description}
                </Typography>
              </Box>
            </Box>
          ))}
        </Box>

        <Box sx={{ mt: 3.25 }}>
          <Box sx={{ alignItems: 'center', display: 'flex', gap: 1 }}>
            <GroupsRoundedIcon sx={{ color: '#52a8ff', fontSize: 21 }} />
            <Typography sx={{ fontSize: 17, fontWeight: 700 }}>
              From legacy Q-Chat to Reticulum Q-Chat
            </Typography>
          </Box>
          <Typography
            sx={{
              color: 'text.secondary',
              fontSize: 13.5,
              lineHeight: 1.6,
              mt: 0.75,
            }}
          >
            Legacy Q-Chat established decentralized social communication inside
            Qortal. The Reticulum edition builds on that achievement with a
            network and interface designed for faster, more interactive daily
            conversation.
          </Typography>

          <Box
            role="table"
            aria-label="Legacy and Reticulum Q-Chat comparison"
            sx={{
              border: '1px solid',
              borderColor: 'divider',
              borderRadius: '9px',
              mt: 1.5,
              overflow: 'hidden',
            }}
          >
            <Box
              role="row"
              sx={{
                backgroundColor: 'action.hover',
                display: 'grid',
                gap: 1,
                gridTemplateColumns: '0.75fr 1.2fr 1.2fr',
                px: 1.75,
                py: 1.1,
              }}
            >
              {['Area', 'Legacy Q-Chat', 'Reticulum Q-Chat'].map((label) => (
                <Typography
                  key={label}
                  role="columnheader"
                  sx={{ fontSize: 12, fontWeight: 700 }}
                >
                  {label}
                </Typography>
              ))}
            </Box>
            {COMPARISON_ROWS.map((row, index) => (
              <Box
                key={row.area}
                role="row"
                sx={{
                  borderTop: index === 0 ? '1px solid' : '1px solid',
                  borderColor: 'divider',
                  display: 'grid',
                  gap: 1,
                  gridTemplateColumns: '0.75fr 1.2fr 1.2fr',
                  px: 1.75,
                  py: 1.25,
                }}
              >
                <Typography
                  role="cell"
                  sx={{ fontSize: 12.5, fontWeight: 650 }}
                >
                  {row.area}
                </Typography>
                <Typography
                  role="cell"
                  sx={{ color: 'text.secondary', fontSize: 12.5 }}
                >
                  {row.legacy}
                </Typography>
                <Typography
                  role="cell"
                  sx={{ color: 'text.secondary', fontSize: 12.5 }}
                >
                  {row.reticulum}
                </Typography>
              </Box>
            ))}
          </Box>

          <Box
            sx={{
              display: 'grid',
              gap: 1.5,
              gridTemplateColumns: {
                xs: 'minmax(0, 1fr)',
                sm: 'repeat(2, minmax(0, 1fr))',
              },
              mt: 2,
            }}
          >
            <Box>
              <Typography sx={{ fontSize: 13, fontWeight: 700, mb: 0.75 }}>
                Legacy Q-Chat (2022)
              </Typography>
              <Box
                aria-label="Legacy Q-Chat image placeholder"
                sx={{
                  alignItems: 'center',
                  aspectRatio: '16 / 9',
                  backgroundColor: 'action.hover',
                  border: '1px dashed',
                  borderColor: 'divider',
                  borderRadius: '9px',
                  color: 'text.secondary',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 0.75,
                  justifyContent: 'center',
                  minHeight: 150,
                  position: 'relative',
                  px: 2,
                  textAlign: 'center',
                }}
              >
                <FavoriteRoundedIcon
                  aria-label="Celebrating Legacy Q-Chat"
                  sx={{
                    color: '#ef476f',
                    fontSize: 23,
                    left: 12,
                    position: 'absolute',
                    top: 10,
                  }}
                />
                <ForumRoundedIcon sx={{ fontSize: 28, opacity: 0.65 }} />
                <Typography sx={{ fontSize: 12.5, fontWeight: 600 }}>
                  Legacy interface image coming soon
                </Typography>
              </Box>
            </Box>
            <Box>
              <Typography sx={{ fontSize: 13, fontWeight: 700, mb: 0.75 }}>
                Reticulum Q-Chat (2026)
              </Typography>
              <Box
                sx={{
                  aspectRatio: '16 / 9',
                  backgroundColor: 'action.hover',
                  border: '1px solid',
                  borderColor: 'divider',
                  borderRadius: '9px',
                  overflow: 'hidden',
                  position: 'relative',
                  width: '100%',
                }}
              >
                <Box
                  alt="Reticulum Q-Chat interface in 2026"
                  component="img"
                  src={reticulumQChat2026}
                  sx={{
                    display: 'block',
                    height: '100%',
                    objectFit: 'contain',
                    width: '100%',
                  }}
                />
                <StarRoundedIcon
                  aria-label="Celebrating Reticulum Q-Chat"
                  sx={{
                    color: '#f6c344',
                    filter: 'drop-shadow(0 1px 3px rgba(0, 0, 0, 0.55))',
                    fontSize: 25,
                    left: 12,
                    position: 'absolute',
                    top: 10,
                  }}
                />
              </Box>
            </Box>
          </Box>
        </Box>

        <Typography
          sx={{
            color: 'text.secondary',
            fontSize: 13.5,
            lineHeight: 1.65,
            mt: 3,
            pb: 0.5,
          }}
        >
          This is the beginning of the new Q-Chat. More social experiences,
          community tools, and refinements are already on the way.
        </Typography>
      </DialogContent>
    </Dialog>
  );
}
