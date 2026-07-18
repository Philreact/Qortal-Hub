import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Avatar,
  Box,
  Button,
  Dialog,
  DialogContent,
  Skeleton,
  Tooltip,
  Typography,
} from '@mui/material';
import CheckRoundedIcon from '@mui/icons-material/CheckRounded';
import ContentCopyRoundedIcon from '@mui/icons-material/ContentCopyRounded';
import LockRoundedIcon from '@mui/icons-material/LockRounded';
import PublicRoundedIcon from '@mui/icons-material/PublicRounded';
import { getBaseApiReact } from '../../App';
import { QORTAL_PROTOCOL } from '../../constants/constants';
import { subscribeToEvent, unsubscribeFromEvent } from '../../utils/events';
import { getNameInfo } from './groupApi';
import { GroupLevelBadge } from './ReticulumGroupLevel';
import qortalWhiteLogo from '../../assets/sidebar/qortal-logo-white.png';

const GROUP_META_TTL = 5 * 60 * 1000;
const metadataCache = new Map<string, { data: any; fetchedAt: number }>();
const inflightMetadata = new Map<string, Promise<any>>();

export const getLegacyLevel = (timestamp?: number | string) => {
  const created = Number(timestamp);
  if (!Number.isFinite(created) || created <= 0) return null;
  const start = new Date(created);
  const now = new Date();
  let years = now.getFullYear() - start.getFullYear();
  if (
    now.getMonth() < start.getMonth() ||
    (now.getMonth() === start.getMonth() && now.getDate() < start.getDate())
  ) years -= 1;
  return Math.max(1, years + 1);
};

export const getCommunityLevel = (count?: number) => {
  const members = Math.max(0, Number(count) || 0);
  if (members <= 10) return 1;
  if (members <= 25) return 2;
  if (members <= 50) return 3;
  if (members <= 99) return 4;
  if (members <= 249) return 5;
  if (members <= 499) return 6;
  if (members <= 999) return 7;
  if (members <= 2499) return 8;
  if (members <= 4999) return 9;
  return 10;
};

export const getGroupLevelColor = (level: number) => {
  if (level === 1) return '#D7DCE5';
  if (level === 2) return '#4CCB78';
  if (level === 3) return '#4C8DFF';
  if (level === 4) return '#A970FF';
  if (level === 5) return '#FF9F43';
  return '#FF5364';
};

const getMetadata = async (group: any, force = false) => {
  const id = String(group?.groupId ?? '');
  if (!id) return group;
  const cached = metadataCache.get(id);
  if (!force && cached && Date.now() - cached.fetchedAt < GROUP_META_TTL) {
    return { ...group, ...cached.data };
  }
  if (!force && inflightMetadata.has(id)) return inflightMetadata.get(id);
  const request = fetch(`${getBaseApiReact()}/groups/${id}`)
    .then(async (response) => {
      if (response.status === 404) throw new Error('GROUP_NOT_FOUND');
      if (!response.ok) throw new Error('Unable to load group details');
      const data = await response.json();
      metadataCache.set(id, { data, fetchedAt: Date.now() });
      return { ...group, ...data };
    })
    .catch((error) => ({
      ...group,
      __reticulumGroupLoadError: true,
      __reticulumGroupMissing: error?.message === 'GROUP_NOT_FOUND',
    }))
    .finally(() => inflightMetadata.delete(id));
  inflightMetadata.set(id, request);
  return request;
};

export const getReticulumGroupMetadata = (
  groupOrId: any,
  force = false
) =>
  getMetadata(
    typeof groupOrId === 'object' ? groupOrId : { groupId: groupOrId },
    force
  );

export const prefetchReticulumGroupAboutMetadata = (group: any) => {
  if (!group?.groupId) return;
  void getMetadata(group);
};

const truncateInvite = (value: string) =>
  value.length > 34 ? `${value.slice(0, 18)}...${value.slice(-12)}` : value;

const yearsAgo = (timestamp?: number | string) => {
  const years = getLegacyLevel(timestamp);
  return years ? Math.max(0, years - 1) : null;
};

const formatCreatedDate = (timestamp?: number | string) => {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value <= 0) return 'Unknown';
  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(value));
};

export const ReticulumGroupAboutModal = () => {
  const [requestedGroup, setRequestedGroup] = useState<any>(null);
  const [details, setDetails] = useState<any>(null);
  const [ownerName, setOwnerName] = useState('');
  const [avatarLoaded, setAvatarLoaded] = useState(false);
  const [copied, setCopied] = useState(false);
  const descriptionRef = useRef<HTMLParagraphElement | null>(null);
  const [descriptionOverflowing, setDescriptionOverflowing] = useState(false);

  useEffect(() => {
    const open = (event: CustomEvent) => setRequestedGroup(event.detail?.group ?? null);
    subscribeToEvent('openReticulumGroupAbout', open);
    return () => unsubscribeFromEvent('openReticulumGroupAbout', open);
  }, []);

  useEffect(() => {
    let active = true;
    setDetails(null);
    setOwnerName('');
    setAvatarLoaded(false);
    setCopied(false);
    if (!requestedGroup?.groupId) return undefined;
    getMetadata(requestedGroup).then(async (next) => {
      if (!active) return;
      setDetails(next);
      const resolvedOwnerName = next?.ownerPrimaryName || (next?.owner ? await getNameInfo(next.owner).catch(() => '') : '');
      if (active) setOwnerName(resolvedOwnerName || '');
    });
    return () => { active = false; };
  }, [requestedGroup]);

  const data = details || requestedGroup;
  const groupId = data?.groupId;
  const groupName = data?.groupName || data?.name || 'Group';
  const memberCount = data?.memberCount;
  const created = data?.created ?? data?.creationTimestamp ?? data?.createdAt;
  const legacyLevel = getLegacyLevel(created);
  const communityLevel = getCommunityLevel(memberCount);
  const inviteLink = groupId ? `${QORTAL_PROTOCOL}use-group/action-join/groupid-${groupId}` : '';
  const description = data?.description ?? data?.groupDescription ?? '';
  const isOpen = data?.isOpen === true || data?.groupType === 0 || data?.groupType === 'OPEN';
  const avatarUrl = ownerName && groupId
    ? `${getBaseApiReact()}/arbitrary/THUMBNAIL/${ownerName}/qortal_group_avatar_${groupId}?async=true`
    : undefined;

  const measureDescription = useCallback(() => {
    const element = descriptionRef.current;
    if (!element) return;
    setDescriptionOverflowing(element.scrollHeight > element.clientHeight + 1);
  }, []);

  useEffect(() => {
    measureDescription();
    const observer = typeof ResizeObserver === 'undefined' || !descriptionRef.current
      ? null
      : new ResizeObserver(measureDescription);
    if (observer && descriptionRef.current) observer.observe(descriptionRef.current);
    return () => observer?.disconnect();
  }, [description, measureDescription]);

  const copyInvite = useCallback(async () => {
    if (!inviteLink) return;
    await navigator.clipboard.writeText(inviteLink);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }, [inviteLink]);

  const close = () => setRequestedGroup(null);
  const statRows = [
    ['Owner', ownerName || data?.owner || 'Unknown'],
    ['Group type', isOpen ? 'Open' : 'Closed'],
    ['Created', formatCreatedDate(created)],
  ];

  return (
    <Dialog
      open={Boolean(requestedGroup)}
      onClose={close}
      maxWidth={false}
      PaperProps={{
        sx: {
          background: 'linear-gradient(180deg, #1b1e23 0%, #15181d 100%)',
          border: '1px solid #343a44',
          borderRadius: '12px',
          boxShadow: '0 22px 56px rgba(0, 0, 0, 0.5)',
          maxHeight: 'calc(100vh - 32px)',
          m: 2,
          width: 'min(480px, calc(100vw - 32px))',
        },
      }}
    >
      <DialogContent sx={{ p: 3 }}>
        {!details ? (
          <Box sx={{ display: 'grid', gap: 1.5 }}>
            <Skeleton height={76} variant="circular" width={76} />
            <Skeleton height={30} width="54%" />
            <Skeleton height={20} width="34%" />
            <Skeleton height={90} />
          </Box>
        ) : (
          <>
            <Box sx={{ alignItems: 'center', display: 'flex', flexDirection: 'column', textAlign: 'center' }}>
              <Avatar
                alt={groupName}
                imgProps={{ onError: () => setAvatarLoaded(false), onLoad: () => setAvatarLoaded(true) }}
                src={avatarUrl}
                sx={{ backgroundColor: 'rgba(255,255,255,0.045)', fontSize: 28, fontWeight: 800, height: 82, mb: 1.25, width: 82 }}
              >
                {!avatarLoaded ? <Box alt="" aria-hidden component="img" src={qortalWhiteLogo} sx={{ height: '42%', objectFit: 'contain', opacity: 0.15, width: '42%' }} /> : null}
              </Avatar>
              <Typography sx={{ fontSize: 24, fontWeight: 750, lineHeight: 1.2 }}>{groupName}</Typography>
              <Box sx={{ mt: 1.15 }}>
                <GroupLevelBadge
                  communityLevel={communityLevel}
                  created={created}
                  legacyLevel={legacyLevel}
                  memberCount={Number(memberCount) || 0}
                  size="full"
                />
              </Box>
              <Box sx={{ alignItems: 'center', color: 'text.secondary', display: 'inline-flex', gap: 0.75, mt: 0.85 }}>
                {isOpen ? <PublicRoundedIcon sx={{ fontSize: 17 }} /> : <LockRoundedIcon sx={{ fontSize: 17 }} />}
                <Typography sx={{ fontSize: 13 }}>{isOpen ? 'Open group' : 'Closed group'}</Typography>
              </Box>
            </Box>

            {description && (
              <Tooltip arrow disableHoverListener={!descriptionOverflowing} title={description}>
                <Typography ref={descriptionRef} sx={{ WebkitBoxOrient: 'vertical', WebkitLineClamp: 3, color: 'text.secondary', display: '-webkit-box', fontSize: 14, lineHeight: 1.45, mt: 2, overflow: 'hidden', textAlign: 'center' }}>
                  {description}
                </Typography>
              </Tooltip>
            )}

            <Box sx={{ borderTop: '1px solid rgba(255,255,255,0.085)', display: 'grid', gap: 1.1, mt: 2, pt: 1.75 }}>
              {statRows.map(([label, value]) => (
                <Box key={label} sx={{ display: 'flex', justifyContent: 'space-between', gap: 2 }}>
                  <Typography sx={{ color: 'text.secondary', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>{label}</Typography>
                  <Typography sx={{ color: label === 'Owner' ? '#FFB35D' : 'text.primary', fontSize: 13, fontWeight: 600, maxWidth: '58%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</Typography>
                </Box>
              ))}
            </Box>

            <Box sx={{ alignItems: 'center', borderTop: '1px solid rgba(255,255,255,0.085)', display: 'flex', gap: 1, justifyContent: 'space-between', mt: 2, pt: 1.75 }}>
              <Box sx={{ minWidth: 0 }}>
                <Typography sx={{ color: 'text.secondary', fontSize: 10, fontWeight: 800, letterSpacing: '0.08em' }}>GROUP INVITE LINK</Typography>
                <Typography title={inviteLink} sx={{ fontSize: 12, mt: 0.2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{truncateInvite(inviteLink)}</Typography>
              </Box>
              <Tooltip title={copied ? 'Copied' : 'Copy invite link'}>
                <Button onClick={copyInvite} size="small" sx={{ flexShrink: 0, minWidth: 36, mt: 0.35, p: 0.75 }}>
                  {copied ? <CheckRoundedIcon fontSize="small" /> : <ContentCopyRoundedIcon fontSize="small" />}
                </Button>
              </Tooltip>
            </Box>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
};
