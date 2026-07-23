import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Editor } from '@tiptap/core';
import {
  Box,
  Button,
  CircularProgress,
  Dialog,
  IconButton,
  Tooltip,
  Typography,
} from '@mui/material';
import { alpha, useTheme } from '@mui/material/styles';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import ForumRoundedIcon from '@mui/icons-material/ForumRounded';
import ImageRoundedIcon from '@mui/icons-material/ImageRounded';
import InsertDriveFileRoundedIcon from '@mui/icons-material/InsertDriveFileRounded';
import SendRoundedIcon from '@mui/icons-material/SendRounded';
import { MAX_SIZE_MESSAGE } from '../../constants/constants';
import Tiptap from './TipTap';
import { MessageItem } from './MessageItem';
import { ReticulumGifCompressionStatus } from './ReticulumGifCompressionStatus';
import { ReticulumMessageExpiryButton } from './ReticulumMessageExpiryButton';

const RETICULUM_BLUE = '#2563eb';

export type ReticulumDiscussionFile = {
  base64?: string;
  fileName: string;
  filePath?: string;
  height?: number;
  isImage: boolean;
  mimeType: string;
  previewUrl?: string;
  sizeBytes: number;
  temporaryFilePath?: string;
  width?: number;
};

export type ReticulumDiscussionDraft = {
  expiryDurationMs?: number;
  htmlContent: string;
  messageText: Record<string, unknown>;
};

type ReticulumDiscussionDialogProps = {
  canWrite: boolean;
  channelExpiryDurationMs?: number;
  compressingGif: boolean;
  files: ReticulumDiscussionFile[];
  loading: boolean;
  membersWithNames: unknown[];
  messages: any[];
  myAddress: string;
  onClose: () => void;
  onRemoveFile: (index: number) => void;
  onSelectFiles: (files: File[]) => void | Promise<void>;
  onSend: (draft: ReticulumDiscussionDraft) => Promise<boolean>;
  onTypingChange: (active: boolean) => void;
  open: boolean;
  replyCount: number;
  reticulumGroupAvatarOwnerName?: string;
  reticulumGroupDisplayName?: string;
  reticulumMemberJoinedByAddress?: Record<string, number>;
  reticulumMemberRolesByAddress?: Record<string, 'owner' | 'admin'>;
  reticulumMemberRolesReady?: boolean;
  reticulumMentionUsers?: Record<
    string,
    { address: string; joined?: number; name: string }
  >;
  preparingFile: boolean;
  selectedGroup: number | string;
};

export const ReticulumDiscussionDialog = ({
  canWrite,
  channelExpiryDurationMs,
  compressingGif,
  files,
  loading,
  membersWithNames,
  messages,
  myAddress,
  onClose,
  onRemoveFile,
  onSelectFiles,
  onSend,
  onTypingChange,
  open,
  replyCount,
  reticulumGroupAvatarOwnerName,
  reticulumGroupDisplayName,
  reticulumMemberJoinedByAddress,
  reticulumMemberRolesByAddress,
  reticulumMemberRolesReady = true,
  reticulumMentionUsers,
  preparingFile,
  selectedGroup,
}: ReticulumDiscussionDialogProps) => {
  const theme = useTheme();
  const [editor, setEditor] = useState<Editor | null>(null);
  const [expiryDurationMs, setExpiryDurationMs] = useState<
    number | undefined
  >();
  const [formattingResetKey, setFormattingResetKey] = useState(0);
  const [focused, setFocused] = useState(false);
  const [messageSize, setMessageSize] = useState(0);
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const rootMessage = messages[0] || null;
  const messageById = useMemo(
    () =>
      new Map(
        messages.map((message) => [String(message?.signature || ''), message])
      ),
    [messages]
  );
  const rowVirtualizer = useVirtualizer({
    count: messages.length,
    estimateSize: () => 92,
    getItemKey: (index) =>
      String(messages[index]?.signature || `discussion-message-${index}`),
    getScrollElement: () => scrollRef.current,
    overscan: 8,
  });

  useEffect(() => {
    if (open) return;
    editor?.commands.clearContent();
    setExpiryDurationMs(undefined);
    setMessageSize(0);
    setFormattingResetKey((key) => key + 1);
  }, [editor, open]);

  useEffect(() => {
    if (!open || messages.length === 0) return;
    window.requestAnimationFrame(() => {
      rowVirtualizer.scrollToIndex(messages.length - 1, { align: 'end' });
    });
  }, [messages.length, open, rowVirtualizer]);

  const send = async () => {
    if (!canWrite || !editor || sending || preparingFile || loading) return;
    const htmlContent = editor.getHTML();
    const hasText = Boolean(editor.getText().trim());
    if (!hasText && files.length === 0) return;
    const messageText = editor.getJSON() as Record<string, unknown>;
    const payloadSize = JSON.stringify(messageText).length + 300;
    if (payloadSize > MAX_SIZE_MESSAGE) return;
    setSending(true);
    try {
      if (
        await onSend({
          expiryDurationMs,
          htmlContent,
          messageText,
        })
      ) {
        editor.commands.clearContent();
        setExpiryDurationMs(undefined);
        setMessageSize(0);
        setFormattingResetKey((key) => key + 1);
      }
    } finally {
      setSending(false);
    }
  };

  const closeDisabled = sending || preparingFile;
  const sendDisabled =
    loading ||
    !canWrite ||
    closeDisabled ||
    messageSize > MAX_SIZE_MESSAGE ||
    (!editor?.getText().trim() && files.length === 0);

  return (
    <Dialog
      BackdropProps={{
        sx: {
          backdropFilter: 'blur(3px)',
          backgroundColor: 'rgba(3, 6, 12, 0.76)',
        },
      }}
      fullWidth
      maxWidth={false}
      onClose={closeDisabled ? undefined : onClose}
      open={open}
      PaperProps={{
        sx: {
          backgroundColor: theme.palette.background.default,
          backgroundImage: 'none',
          border: '1px solid',
          borderColor: alpha(theme.palette.divider, 0.9),
          borderRadius: '12px',
          boxShadow: '0 26px 80px rgba(0,0,0,0.58)',
          height: { xs: '88vh', sm: '80vh' },
          m: { xs: 1, sm: 2.5 },
          maxWidth: 720,
          overflow: 'hidden',
          width: { xs: 'calc(100vw - 16px)', sm: 'min(720px, 62vw)' },
        },
      }}
    >
      <Box
        sx={{
          alignItems: 'center',
          backgroundColor: alpha(theme.palette.background.paper, 0.72),
          borderBottom: '1px solid',
          borderColor: 'divider',
          display: 'flex',
          justifyContent: 'space-between',
          minHeight: 62,
          px: 2,
        }}
      >
        <Box sx={{ alignItems: 'center', display: 'flex', gap: 1.15 }}>
          <Box
            sx={{
              alignItems: 'center',
              backgroundColor: alpha(RETICULUM_BLUE, 0.14),
              border: `1px solid ${alpha(RETICULUM_BLUE, 0.32)}`,
              borderRadius: '9px',
              color: RETICULUM_BLUE,
              display: 'flex',
              height: 36,
              justifyContent: 'center',
              width: 36,
            }}
          >
            <ForumRoundedIcon sx={{ fontSize: 20 }} />
          </Box>
          <Box>
            <Typography
              sx={{ fontSize: 16, fontWeight: 750, lineHeight: 1.25 }}
            >
              Discussion
            </Typography>
            <Typography sx={{ color: 'text.secondary', fontSize: 12 }}>
              {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
            </Typography>
          </Box>
        </Box>
        <IconButton
          aria-label="Close discussion"
          disabled={closeDisabled}
          onClick={closeDisabled ? undefined : onClose}
          size="small"
          sx={{ color: 'text.secondary' }}
        >
          <CloseRoundedIcon />
        </IconButton>
      </Box>

      <Box
        data-reticulum-chat-root="true"
        ref={scrollRef}
        sx={{ flex: 1, minHeight: 0, overflowY: 'auto', py: 1 }}
      >
        {loading ? (
          <Box sx={{ display: 'grid', height: '100%', placeItems: 'center' }}>
            <CircularProgress size={26} />
          </Box>
        ) : messages.length === 0 ? (
          <Box sx={{ display: 'grid', height: '100%', placeItems: 'center' }}>
            <Typography sx={{ color: 'text.secondary', fontSize: 14 }}>
              This discussion is no longer available.
            </Typography>
          </Box>
        ) : (
          <Box
            sx={{
              height: rowVirtualizer.getTotalSize(),
              position: 'relative',
              width: '100%',
            }}
          >
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const index = virtualRow.index;
              const message = messages[index];
              const reply = message?.repliedTo
                ? messageById.get(String(message.repliedTo)) || rootMessage
                : null;
              return (
                <Box
                  data-index={index}
                  key={virtualRow.key}
                  ref={rowVirtualizer.measureElement}
                  sx={{
                    borderLeft:
                      index === 0 ? `2px solid ${RETICULUM_BLUE}` : undefined,
                    left: 0,
                    position: 'absolute',
                    top: 0,
                    transform: `translateY(${virtualRow.start}px)`,
                    width: '100%',
                  }}
                >
                  <MessageItem
                    handleReaction={() => undefined}
                    isLast={index === messages.length - 1}
                    isPrivate={false}
                    isTemp={false}
                    isUpdating={false}
                    lastSignature={String(messages.at(-1)?.signature || '')}
                    message={message}
                    myAddress={myAddress}
                    onDelete={() => undefined}
                    onEdit={() => undefined}
                    onReply={() => undefined}
                    onSeen={() => undefined}
                    reactions={null}
                    reply={reply}
                    replyIndex={0}
                    reticulumChatEnabled
                    reticulumDiscussionRootId={String(
                      rootMessage?.signature || ''
                    )}
                    reticulumDiscussionView
                    reticulumGroupAvatarOwnerName={
                      reticulumGroupAvatarOwnerName
                    }
                    reticulumGroupDisplayName={reticulumGroupDisplayName}
                    reticulumMemberJoinedByAddress={
                      reticulumMemberJoinedByAddress
                    }
                    reticulumMemberRolesByAddress={
                      reticulumMemberRolesByAddress
                    }
                    reticulumMemberRolesReady={reticulumMemberRolesReady}
                    reticulumMentionUsers={reticulumMentionUsers}
                    scrollToItem={() => undefined}
                    selectedGroup={selectedGroup}
                  />
                </Box>
              );
            })}
          </Box>
        )}
      </Box>

      <Box
        sx={{
          backgroundColor: alpha(theme.palette.background.paper, 0.72),
          borderTop: '1px solid',
          borderColor: 'divider',
          p: 1.25,
        }}
      >
        {(files.length > 0 || preparingFile) && (
          <Box
            sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mb: 1, px: 0.25 }}
          >
            {compressingGif ? (
              <ReticulumGifCompressionStatus />
            ) : preparingFile ? (
              <Box
                sx={{ alignItems: 'center', display: 'flex', gap: 1, px: 0.5 }}
              >
                <CircularProgress size={16} />
                <Typography sx={{ color: 'text.secondary', fontSize: 12 }}>
                  Preparing attachment…
                </Typography>
              </Box>
            ) : null}
            {files.map((file, index) => (
              <Box
                key={`${file.fileName}-${index}`}
                sx={{
                  alignItems: 'center',
                  backgroundColor: alpha(
                    theme.palette.background.default,
                    0.72
                  ),
                  border: '1px solid',
                  borderColor: 'divider',
                  borderRadius: '8px',
                  display: 'flex',
                  gap: 1,
                  maxWidth: 280,
                  minHeight: 48,
                  p: 0.75,
                }}
              >
                {file.previewUrl ? (
                  <Box
                    component="img"
                    src={file.previewUrl}
                    sx={{
                      borderRadius: '5px',
                      height: 36,
                      objectFit: 'cover',
                      width: 36,
                    }}
                  />
                ) : file.isImage ? (
                  <ImageRoundedIcon sx={{ color: 'text.secondary' }} />
                ) : (
                  <InsertDriveFileRoundedIcon
                    sx={{ color: 'text.secondary' }}
                  />
                )}
                <Typography
                  sx={{
                    flex: 1,
                    fontSize: 12,
                    fontWeight: 600,
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {file.fileName}
                </Typography>
                <Tooltip title="Remove attachment">
                  <IconButton
                    aria-label={`Remove ${file.fileName}`}
                    onClick={() => onRemoveFile(index)}
                    size="small"
                  >
                    <CloseRoundedIcon sx={{ fontSize: 17 }} />
                  </IconButton>
                </Tooltip>
              </Box>
            ))}
          </Box>
        )}

        <Box sx={{ alignItems: 'center', display: 'flex', gap: 1 }}>
          <Tiptap
            collapseFormattingTraySignal={formattingResetKey}
            compactActions={
              <ReticulumMessageExpiryButton
                channelExpiryDurationMs={channelExpiryDurationMs}
                disabled={loading || closeDisabled}
                disabledReason="Wait until the discussion is ready"
                onChange={setExpiryDurationMs}
                value={expiryDurationMs}
              />
            }
            compactChat
            disableEnter={!canWrite || loading || closeDisabled}
            enableMentions
            insertFiles={onSelectFiles}
            isChat
            isFocusedParent={focused}
            membersWithNames={membersWithNames}
            onContentUpdate={(nextEditor) => {
              setMessageSize(JSON.stringify(nextEditor.getJSON()).length + 300);
              onTypingChange(Boolean(nextEditor.getText().trim()));
            }}
            onEnter={send}
            placeholder="Reply to discussion..."
            setEditorRef={setEditor}
            setIsFocusedParent={setFocused}
          />
          <Button
            disabled={sendDisabled}
            onClick={() => void send()}
            startIcon={
              sending ? (
                <CircularProgress color="inherit" size={16} />
              ) : (
                <SendRoundedIcon sx={{ fontSize: 18 }} />
              )
            }
            sx={{
              backgroundColor: RETICULUM_BLUE,
              borderRadius: '8px',
              color: 'common.white',
              flexShrink: 0,
              fontWeight: 650,
              minHeight: 38,
              minWidth: 82,
              px: 1.5,
              textTransform: 'none',
              '&:hover': { backgroundColor: '#1e40af' },
            }}
            variant="contained"
          >
            Send
          </Button>
        </Box>
        {!canWrite && (
          <Typography
            sx={{ color: 'text.secondary', fontSize: 11.5, mt: 0.5, pl: 0.5 }}
          >
            Only group admins can write in this channel.
          </Typography>
        )}
        {messageSize >= 3200 && (
          <Typography
            sx={{
              color:
                messageSize > MAX_SIZE_MESSAGE
                  ? 'error.main'
                  : 'text.secondary',
              fontSize: 11,
              mt: 0.5,
              pl: 0.5,
            }}
          >
            {messageSize} / {MAX_SIZE_MESSAGE} bytes
          </Typography>
        )}
      </Box>
    </Dialog>
  );
};
