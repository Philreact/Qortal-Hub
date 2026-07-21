import EmojiEmotionsRoundedIcon from '@mui/icons-material/EmojiEmotionsRounded';
import SendRoundedIcon from '@mui/icons-material/SendRounded';
import {
  Box,
  Button,
  IconButton,
  Popover,
  Stack,
  TextField,
  Tooltip,
  Typography,
  alpha,
} from '@mui/material';
import Picker, { EmojiStyle, Theme, type EmojiClickData } from 'emoji-picker-react';
import { useEffect, useRef, useState } from 'react';

export type GameChatMessage = {
  messageId: string;
  authorAddress: string;
  text: string;
  createdAt: number;
  delivered: boolean;
  failed?: boolean;
};

type Props = {
  address: string;
  disabled: boolean;
  messages: GameChatMessage[];
  opponentName: string;
  remoteTyping: boolean;
  onSend: (text: string) => boolean;
  onTyping: (active: boolean) => void;
};

const CHAT_LIMIT = 500;

export function GameSessionChat({
  address,
  disabled,
  messages,
  opponentName,
  remoteTyping,
  onSend,
  onTyping,
}: Props) {
  const [draft, setDraft] = useState('');
  const [emojiAnchor, setEmojiAnchor] = useState<HTMLElement | null>(null);
  const [unread, setUnread] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const nearBottomRef = useRef(true);
  const previousCountRef = useRef(0);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    if (nearBottomRef.current) {
      element.scrollTop = element.scrollHeight;
      setUnread(0);
    } else if (messages.length > previousCountRef.current) {
      setUnread((value) => value + messages.length - previousCountRef.current);
    }
    previousCountRef.current = messages.length;
  }, [messages.length, remoteTyping]);

  useEffect(() => () => onTyping(false), [onTyping]);

  const submit = () => {
    const text = draft.trim();
    if (!text || disabled || !onSend(text)) return;
    setDraft('');
    onTyping(false);
  };

  const insertEmoji = (emoji: EmojiClickData) => {
    const input = inputRef.current;
    const start = input?.selectionStart ?? draft.length;
    const end = input?.selectionEnd ?? start;
    const next = `${draft.slice(0, start)}${emoji.emoji}${draft.slice(end)}`.slice(0, CHAT_LIMIT);
    setDraft(next);
    onTyping(Boolean(next));
    setEmojiAnchor(null);
    window.setTimeout(() => {
      input?.focus();
      const cursor = Math.min(start + emoji.emoji.length, next.length);
      input?.setSelectionRange(cursor, cursor);
    });
  };

  return (
    <Box
      aria-label="Private game chat"
      sx={{
        borderLeft: { md: `1px solid ${alpha('#fff', 0.1)}` },
        borderTop: { xs: `1px solid ${alpha('#fff', 0.1)}`, md: 0 },
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: { xs: 230, md: 480 },
        minWidth: 0,
        pl: { md: 2 },
        pt: { xs: 2, md: 0 },
      }}
    >
      <Box sx={{ mb: 1 }}>
        <Typography sx={{ fontSize: 14, fontWeight: 850 }}>Private chat</Typography>
        <Typography sx={{ color: alpha('#fff', 0.46), fontSize: 10 }}>
          Temporary · cleared when this private session ends
        </Typography>
      </Box>

      <Stack
        ref={scrollRef}
        onScroll={(event) => {
          const element = event.currentTarget;
          nearBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 36;
          if (nearBottomRef.current) setUnread(0);
        }}
        spacing={0.8}
        sx={{ flex: 1, maxHeight: { xs: 210, md: 'none' }, minHeight: { xs: 150, md: 0 }, overflowY: 'auto', pr: 0.5 }}
      >
        {messages.length === 0 && (
          <Typography sx={{ color: alpha('#fff', 0.38), fontSize: 12, mt: 2, textAlign: 'center' }}>
            Messages stay between you and {opponentName}.
          </Typography>
        )}
        {messages.map((message) => {
          const local = message.authorAddress === address;
          return (
            <Box key={message.messageId} sx={{ alignSelf: local ? 'flex-end' : 'flex-start', maxWidth: '88%' }}>
              <Box sx={{ backgroundColor: local ? alpha('#2cf8ff', 0.16) : alpha('#fff', 0.08), border: `1px solid ${local ? alpha('#2cf8ff', 0.25) : alpha('#fff', 0.1)}`, borderRadius: local ? '12px 12px 3px 12px' : '12px 12px 12px 3px', px: 1.2, py: 0.8 }}>
                <Typography sx={{ fontSize: 12, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>{message.text}</Typography>
              </Box>
              <Typography sx={{ color: alpha('#fff', 0.36), fontSize: 9, mt: 0.25, textAlign: local ? 'right' : 'left' }}>
                {new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                {local ? ` · ${message.failed ? 'Failed' : message.delivered ? 'Delivered' : 'Sending…'}` : ''}
              </Typography>
            </Box>
          );
        })}
        {remoteTyping && (
          <Typography aria-live="polite" sx={{ color: alpha('#9ffcff', 0.72), fontSize: 11, fontStyle: 'italic' }}>
            {opponentName} is typing…
          </Typography>
        )}
      </Stack>

      {unread > 0 && (
        <Button
          onClick={() => {
            const element = scrollRef.current;
            if (element) element.scrollTop = element.scrollHeight;
            nearBottomRef.current = true;
            setUnread(0);
          }}
          size="small"
          sx={{ alignSelf: 'center', fontSize: 10, my: 0.4 }}
        >
          {unread} new {unread === 1 ? 'message' : 'messages'}
        </Button>
      )}

      <Box sx={{ mt: 1 }}>
        <Box sx={{ alignItems: 'flex-end', display: 'flex', gap: 0.5 }}>
          <Tooltip title="Add emoji">
            <span>
              <IconButton disabled={disabled} aria-label="Add emoji" onClick={(event) => setEmojiAnchor(event.currentTarget)} size="small" sx={{ color: '#9ffcff' }}>
                <EmojiEmotionsRoundedIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <TextField
            fullWidth
            inputRef={inputRef}
            disabled={disabled}
            multiline
            maxRows={3}
            placeholder={disabled ? 'Chat unavailable while reconnecting' : 'Message…'}
            value={draft}
            inputProps={{ maxLength: CHAT_LIMIT, 'aria-label': 'Game chat message' }}
            onChange={(event) => {
              setDraft(event.target.value);
              onTyping(Boolean(event.target.value));
            }}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
            size="small"
          />
          <Tooltip title="Send">
            <span>
              <IconButton disabled={disabled || !draft.trim()} aria-label="Send game chat message" onClick={submit} size="small" sx={{ color: '#2cf8ff' }}>
                <SendRoundedIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        </Box>
        <Typography sx={{ color: alpha('#fff', 0.34), fontSize: 9, mt: 0.3, textAlign: 'right' }}>{draft.length}/{CHAT_LIMIT}</Typography>
      </Box>

      <Popover
        anchorEl={emojiAnchor}
        open={Boolean(emojiAnchor)}
        onClose={() => setEmojiAnchor(null)}
        anchorOrigin={{ horizontal: 'left', vertical: 'top' }}
        transformOrigin={{ horizontal: 'left', vertical: 'bottom' }}
      >
        <Picker
          emojiStyle={EmojiStyle.NATIVE}
          height={360}
          lazyLoadEmojis
          onEmojiClick={insertEmoji}
          previewConfig={{ showPreview: false }}
          searchPlaceHolder="Search emojis"
          theme={Theme.DARK}
          width={320}
        />
      </Popover>
    </Box>
  );
}
