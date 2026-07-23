import { Fragment, useContext, useEffect, useState } from 'react';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import IconButton from '@mui/material/IconButton';
import Typography from '@mui/material/Typography';
import ExpandLess from '@mui/icons-material/ExpandLess';
import ExpandMore from '@mui/icons-material/ExpandMore';
import AddRoundedIcon from '@mui/icons-material/AddRounded';
import CheckRoundedIcon from '@mui/icons-material/CheckRounded';
import CheckCircleRoundedIcon from '@mui/icons-material/CheckCircleRounded';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import LockRoundedIcon from '@mui/icons-material/LockRounded';
import PublicRoundedIcon from '@mui/icons-material/PublicRounded';
import TuneRoundedIcon from '@mui/icons-material/TuneRounded';
import {
  Box,
  Collapse,
  FormControl,
  MenuItem,
  Select,
  SelectChangeEvent,
  TextField,
  Tooltip,
} from '@mui/material';
import { UserListOfInvites } from './UserListOfInvites';
import { CustomizedSnackbars } from '../Snackbar/Snackbar';
import { getFee } from '../../background/background.ts';
import { QORTAL_APP_CONTEXT } from '../../App';
import { subscribeToEvent, unsubscribeFromEvent } from '../../utils/events';
import { useTranslation } from 'react-i18next';
import { useSetAtom } from 'jotai';
import { txListAtom } from '../../atoms/global';

const RETICULUM_ACTIVE_BLUE = '#2563eb';
const GROUP_DESCRIPTION_MAX_LENGTH = 300;
const GROUP_MODAL_CONTROL_SX = {
  '& .MuiOutlinedInput-root': {
    backgroundColor: '#0D0F14',
    borderRadius: '8px',
    color: 'text.primary',
    '&:hover .MuiOutlinedInput-notchedOutline': {
      borderColor: 'rgba(255, 255, 255, 0.2)',
    },
    '&.Mui-focused .MuiOutlinedInput-notchedOutline': {
      borderColor: RETICULUM_ACTIVE_BLUE,
      borderWidth: 1,
    },
  },
  '& .MuiOutlinedInput-notchedOutline': {
    borderColor: 'rgba(255, 255, 255, 0.16)',
  },
} as const;

export const AddGroup = ({ address, open, setOpen, initialTab = 0 }) => {
  const { show } = useContext(QORTAL_APP_CONTEXT);
  const setTxList = useSetAtom(txListAtom);

  const [openAdvance, setOpenAdvance] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [groupType, setGroupType] = useState('1');
  const [approvalThreshold, setApprovalThreshold] = useState('40');
  const [minBlock, setMinBlock] = useState('5');
  const [maxBlock, setMaxBlock] = useState('21600');
  const [value, setValue] = useState(initialTab);
  const [openSnack, setOpenSnack] = useState(false);
  const [infoSnack, setInfoSnack] = useState(null);
  const [isCreating, setIsCreating] = useState(false);

  const handleClose = () => {
    if (isCreating) return;
    setOpen(false);
  };

  const handleChangeApprovalThreshold = (event: SelectChangeEvent) => {
    setApprovalThreshold(event.target.value as string);
  };

  const handleChangeMinBlock = (event: SelectChangeEvent) => {
    setMinBlock(event.target.value as string);
  };

  const handleChangeMaxBlock = (event: SelectChangeEvent) => {
    setMaxBlock(event.target.value as string);
  };

  const { t } = useTranslation([
    'auth',
    'core',
    'group',
    'question',
    'tutorial',
  ]);
  const handleCreateGroup = async () => {
    if (isCreating) return;
    try {
      if (!name)
        throw new Error(
          t('group:message.error.name_required', {
            postProcess: 'capitalizeFirstChar',
          })
        );
      if (!description)
        throw new Error(
          t('group:message.error.description_required', {
            postProcess: 'capitalizeFirstChar',
          })
        );
      if (description.length > GROUP_DESCRIPTION_MAX_LENGTH) {
        throw new Error(
          `Description must be ${GROUP_DESCRIPTION_MAX_LENGTH} characters or fewer`
        );
      }

      setIsCreating(true);

      const fee = await getFee('CREATE_GROUP');

      try {
        await show({
          message: t('core:message.question.perform_transaction', {
            action: 'CREATE_GROUP',
            postProcess: 'capitalizeFirstChar',
          }),
          publishFee: fee.fee + ' QORT',
        });
      } catch (error) {
        return;
      }

      await new Promise((res, rej) => {
        window
          .sendMessage('createGroup', {
            groupName: name,
            groupDescription: description,
            groupType: +groupType,
            groupApprovalThreshold: +approvalThreshold,
            minBlock: +minBlock,
            maxBlock: +maxBlock,
          })
          .then((response) => {
            if (!response?.error) {
              setInfoSnack({
                type: 'success',
                message: t('group:message.success.group_creation', {
                  postProcess: 'capitalizeFirstChar',
                }),
              });
              setOpenSnack(true);
              setTxList((prev) => [
                {
                  ...response,
                  type: 'created-group',
                  label: t('group:message.success.group_creation_name', {
                    group_name: name,
                    postProcess: 'capitalizeFirstChar',
                  }),
                  labelDone: t('group:message.success.group_creation_label', {
                    group_name: name,
                    postProcess: 'capitalizeFirstChar',
                  }),
                  done: false,
                },
                ...prev,
              ]);
              setName('');
              setDescription('');
              setGroupType('1');
              res(response);
              return;
            }
            rej({ message: response.error });
          })
          .catch((error) => {
            rej({
              message:
                error.message ||
                t('core:message.error.generic', {
                  postProcess: 'capitalizeFirstChar',
                }),
            });
          });
      });
    } catch (error) {
      setInfoSnack({
        type: 'error',
        message: error?.message,
      });
      setOpenSnack(true);
    } finally {
      setIsCreating(false);
    }
  };

  const openGroupInvitesRequestFunc = () => {
    setValue(2);
  };

  const tabItems = [
    {
      value: 0,
      icon: <AddRoundedIcon sx={{ fontSize: 22 }} />,
      label: t('group:action.create_group', {
        postProcess: 'capitalizeFirstChar',
      }),
    },
    {
      value: 2,
      icon: <CheckRoundedIcon sx={{ fontSize: 21 }} />,
      label: t('group:group.invites', {
        postProcess: 'capitalizeFirstChar',
      }),
    },
  ];

  useEffect(() => {
    if (open) {
      setValue(initialTab);
    }
  }, [initialTab, open]);

  useEffect(() => {
    subscribeToEvent('openGroupInvitesRequest', openGroupInvitesRequestFunc);

    return () => {
      unsubscribeFromEvent(
        'openGroupInvitesRequest',
        openGroupInvitesRequestFunc
      );
    };
  }, []);

  const modeTitle = value === 0 ? 'Create Group' : 'Group invites';
  const modeDescription =
    value === 0
      ? 'Choose a name, describe your group, and get started.'
      : 'Review the invitations you have received.';
  const canCreateGroup =
    Boolean(name.trim() && description.trim()) && !isCreating;

  const handleDialogClose = (_event, reason) => {
    if (isCreating) return;
    // MUI only emits this reason for a primary click on the Dialog backdrop.
    if (reason !== 'backdropClick' && reason !== 'escapeKeyDown') return;
    handleClose();
  };

  if (!open) return null;

  return (
    <Fragment>
      <Dialog
        open={open}
        onClose={handleDialogClose}
        fullWidth
        maxWidth={false}
        PaperProps={{
          sx: {
            backgroundColor: '#1D2028',
            backgroundImage: 'none',
            border: '1px solid rgba(255, 255, 255, 0.13)',
            borderRadius: '12px',
            boxShadow: '0 24px 70px rgba(0, 0, 0, 0.45)',
            display: 'flex',
            flexDirection: 'column',
            height: 'min(680px, calc(100vh - 32px))',
            m: 2,
            maxHeight: 'min(720px, calc(100vh - 32px))',
            maxWidth: 'calc(100vw - 32px)',
            overflow: 'hidden',
            width: 680,
          },
        }}
      >
        <Box
          component="header"
          sx={{
            alignItems: 'flex-start',
            display: 'flex',
            gap: 2,
            justifyContent: 'space-between',
            px: { xs: 2.5, sm: 4 },
            pt: { xs: 2.5, sm: 3.5 },
          }}
        >
          <Box sx={{ minWidth: 0 }}>
            <Typography
              component="h2"
              sx={{
                color: 'text.primary',
                fontSize: { xs: 25, sm: 28 },
                fontWeight: 800,
                lineHeight: 1.15,
              }}
            >
              {modeTitle}
            </Typography>
            <Typography
              sx={{
                color: 'text.secondary',
                fontSize: 14,
                lineHeight: '20px',
                mt: 0.75,
              }}
            >
              {modeDescription}
            </Typography>
          </Box>
          <Box
            aria-label="Group management modes"
            sx={{ display: 'flex', flexShrink: 0, gap: 0.5 }}
          >
            {tabItems.map((item) => {
              const selected = value === item.value;
              return (
                <Tooltip key={item.label} title={item.label}>
                  <IconButton
                    aria-label={item.label}
                    aria-pressed={selected}
                    onClick={() => setValue(item.value)}
                    sx={{
                      backgroundColor: selected
                        ? RETICULUM_ACTIVE_BLUE
                        : 'transparent',
                      borderRadius: '8px',
                      color: selected ? 'common.white' : 'text.secondary',
                      height: 40,
                      width: 40,
                      '&:hover': {
                        backgroundColor: selected
                          ? RETICULUM_ACTIVE_BLUE
                          : 'action.hover',
                        color: 'common.white',
                      },
                    }}
                  >
                    {item.icon}
                  </IconButton>
                </Tooltip>
              );
            })}
          </Box>
        </Box>

        <Box
          sx={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}
        >
          {value === 0 && (
            <Box
              component="form"
              onSubmit={(event) => {
                event.preventDefault();
                void handleCreateGroup();
              }}
              sx={{
                display: 'flex',
                flex: 1,
                flexDirection: 'column',
                gap: 2,
                minHeight: 0,
                overflowY: 'auto',
                px: { xs: 2.5, sm: 4 },
                py: 2.5,
                scrollbarColor: 'rgba(143, 150, 165, 0.7) transparent',
                scrollbarWidth: 'thin',
                '&::-webkit-scrollbar': { width: 7 },
                '&::-webkit-scrollbar-thumb': {
                  backgroundColor: 'rgba(143, 150, 165, 0.7)',
                  borderRadius: 8,
                },
              }}
            >
              <Box>
                <Typography
                  component="label"
                  htmlFor="reticulum-group-name"
                  sx={{
                    color: 'text.primary',
                    display: 'block',
                    fontSize: 15,
                    fontWeight: 800,
                    mb: 1,
                  }}
                >
                  Group name
                </Typography>
                <TextField
                  autoFocus
                  fullWidth
                  id="reticulum-group-name"
                  inputProps={{ maxLength: 32 }}
                  placeholder="e.g. Qortal developers"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  sx={{
                    ...GROUP_MODAL_CONTROL_SX,
                    '& .MuiOutlinedInput-root': {
                      ...GROUP_MODAL_CONTROL_SX['& .MuiOutlinedInput-root'],
                      height: 48,
                    },
                  }}
                />
                <Box
                  sx={{
                    color: 'text.secondary',
                    display: 'flex',
                    fontSize: 12.5,
                    justifyContent: 'space-between',
                    lineHeight: '18px',
                    mt: 0.75,
                  }}
                >
                  <span>Use a clear, recognizable name.</span>
                  <span>{name.length} / 32</span>
                </Box>
              </Box>

              <Box>
                <Typography
                  component="label"
                  htmlFor="reticulum-group-description"
                  sx={{
                    color: 'text.primary',
                    display: 'block',
                    fontSize: 15,
                    fontWeight: 800,
                    mb: 1,
                  }}
                >
                  Description
                </Typography>
                <TextField
                  fullWidth
                  id="reticulum-group-description"
                  inputProps={{ maxLength: GROUP_DESCRIPTION_MAX_LENGTH }}
                  maxRows={4}
                  minRows={2}
                  multiline
                  placeholder="What is this group about?"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  sx={{
                    ...GROUP_MODAL_CONTROL_SX,
                    '& .MuiInputBase-inputMultiline': {
                      scrollbarColor: 'rgba(143, 150, 165, 0.72) transparent',
                      scrollbarWidth: 'thin',
                      '&::-webkit-scrollbar': { width: 6 },
                      '&::-webkit-scrollbar-thumb': {
                        backgroundColor: 'rgba(143, 150, 165, 0.72)',
                        borderRadius: 8,
                      },
                    },
                  }}
                />
                <Box
                  sx={{
                    color: 'text.secondary',
                    display: 'flex',
                    fontSize: 12.5,
                    justifyContent: 'flex-end',
                    lineHeight: '18px',
                    mt: 0.75,
                  }}
                >
                  {description.length} / {GROUP_DESCRIPTION_MAX_LENGTH}
                </Box>
              </Box>

              <Box>
                <Typography
                  id="reticulum-group-access-label"
                  sx={{
                    color: 'text.primary',
                    fontSize: 15,
                    fontWeight: 800,
                    mb: 1,
                  }}
                >
                  Group access
                </Typography>
                <Box
                  aria-labelledby="reticulum-group-access-label"
                  role="radiogroup"
                  sx={{
                    backgroundColor: '#0D0F14',
                    border: '1px solid rgba(0, 0, 0, 0.72)',
                    borderRadius: '10px',
                    display: 'grid',
                    gridTemplateColumns: {
                      xs: '1fr',
                      sm: 'repeat(2, minmax(0, 1fr))',
                    },
                    overflow: 'hidden',
                  }}
                >
                  {[
                    {
                      description: 'Anyone can find and join.',
                      icon: PublicRoundedIcon,
                      label: 'Open',
                      value: '1',
                    },
                    {
                      description: 'Members join by invitation.',
                      icon: LockRoundedIcon,
                      label: 'Closed',
                      value: '0',
                    },
                  ].map((option, index) => {
                    const selected = groupType === option.value;
                    const Icon = option.icon;
                    return (
                      <Button
                        aria-checked={selected}
                        key={option.value}
                        onClick={() => setGroupType(option.value)}
                        role="radio"
                        sx={{
                          backgroundColor: selected
                            ? 'rgba(37, 99, 235, 0.12)'
                            : 'transparent',
                          borderColor: selected
                            ? RETICULUM_ACTIVE_BLUE
                            : 'rgba(0, 0, 0, 0.72)',
                          borderLeft: {
                            xs: 'none',
                            sm:
                              index === 0
                                ? 'none'
                                : '1px solid rgba(0, 0, 0, 0.72)',
                          },
                          borderRadius: {
                            xs: index === 0 ? '9px 9px 0 0' : '0 0 9px 9px',
                            sm: index === 0 ? '9px 0 0 9px' : '0 9px 9px 0',
                          },
                          borderTop: {
                            xs:
                              index === 0
                                ? 'none'
                                : '1px solid rgba(0, 0, 0, 0.72)',
                            sm: 'none',
                          },
                          boxShadow: selected
                            ? `inset 0 0 0 1px ${RETICULUM_ACTIVE_BLUE}`
                            : 'none',
                          color: selected ? 'common.white' : 'text.primary',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 0.5,
                          minHeight: 126,
                          p: 1.5,
                          position: 'relative',
                          textTransform: 'none',
                          zIndex: selected ? 1 : 0,
                          '&:hover': {
                            backgroundColor: selected
                              ? 'rgba(37, 99, 235, 0.16)'
                              : 'action.hover',
                          },
                        }}
                      >
                        {selected && (
                          <CheckCircleRoundedIcon
                            sx={{
                              color: RETICULUM_ACTIVE_BLUE,
                              fontSize: 19,
                              position: 'absolute',
                              right: 9,
                              top: 9,
                            }}
                          />
                        )}
                        <Icon
                          sx={{
                            color: selected ? 'common.white' : 'text.secondary',
                            fontSize: 25,
                          }}
                        />
                        <Typography
                          sx={{
                            color: 'inherit',
                            fontSize: 15,
                            fontWeight: 800,
                          }}
                        >
                          {option.label}
                        </Typography>
                        <Typography
                          sx={{
                            color: 'text.secondary',
                            fontSize: 13,
                            lineHeight: '18px',
                            textAlign: 'center',
                          }}
                        >
                          {option.description}
                        </Typography>
                      </Button>
                    );
                  })}
                </Box>
              </Box>

              <Box>
                <Button
                  aria-expanded={openAdvance}
                  fullWidth
                  onClick={() => setOpenAdvance((previous) => !previous)}
                  startIcon={<TuneRoundedIcon sx={{ fontSize: 18 }} />}
                  sx={{
                    backgroundColor: 'rgba(255, 255, 255, 0.055)',
                    border: '1px solid rgba(255, 255, 255, 0.06)',
                    borderRadius: '8px',
                    color: 'text.primary',
                    justifyContent: 'flex-start',
                    minHeight: 42,
                    px: 1.5,
                    textTransform: 'none',
                    '&:hover': { backgroundColor: 'rgba(255, 255, 255, 0.08)' },
                  }}
                >
                  <Typography
                    sx={{
                      flex: 1,
                      fontSize: 14,
                      fontWeight: 700,
                      textAlign: 'left',
                    }}
                  >
                    Advanced options
                  </Typography>
                  {openAdvance ? <ExpandLess /> : <ExpandMore />}
                </Button>
                <Collapse in={openAdvance} timeout="auto" unmountOnExit>
                  <Box
                    sx={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 2,
                      pt: 2,
                    }}
                  >
                    <Box>
                      <Typography
                        component="label"
                        sx={{
                          color: 'text.primary',
                          display: 'block',
                          fontSize: 13,
                          fontWeight: 700,
                          mb: 0.4,
                        }}
                      >
                        Approval threshold
                      </Typography>
                      <Typography
                        sx={{
                          color: 'text.secondary',
                          fontSize: 12,
                          lineHeight: '17px',
                          mb: 0.85,
                        }}
                      >
                        Percentage of admins required to approve group
                        decisions.
                      </Typography>
                      <FormControl fullWidth sx={GROUP_MODAL_CONTROL_SX}>
                        <Select
                          value={approvalThreshold}
                          onChange={handleChangeApprovalThreshold}
                        >
                          <MenuItem value="0">None</MenuItem>
                          <MenuItem value="1">One</MenuItem>
                          <MenuItem value="20">20%</MenuItem>
                          <MenuItem value="40">40%</MenuItem>
                          <MenuItem value="60">60%</MenuItem>
                          <MenuItem value="80">80%</MenuItem>
                          <MenuItem value="100">100%</MenuItem>
                        </Select>
                      </FormControl>
                    </Box>
                    <Box
                      sx={{
                        display: 'grid',
                        gap: 1.75,
                        gridTemplateColumns: {
                          xs: '1fr',
                          sm: 'repeat(2, minmax(0, 1fr))',
                        },
                      }}
                    >
                      <Box>
                        <Typography
                          component="label"
                          sx={{
                            color: 'text.primary',
                            display: 'block',
                            fontSize: 13,
                            fontWeight: 700,
                            mb: 0.85,
                          }}
                        >
                          Minimum approval delay
                        </Typography>
                        <FormControl fullWidth sx={GROUP_MODAL_CONTROL_SX}>
                          <Select
                            value={minBlock}
                            onChange={handleChangeMinBlock}
                          >
                            <MenuItem value="5">5 minutes</MenuItem>
                            <MenuItem value="10">10 minutes</MenuItem>
                            <MenuItem value="30">30 minutes</MenuItem>
                            <MenuItem value="60">1 hour</MenuItem>
                            <MenuItem value="180">3 hours</MenuItem>
                            <MenuItem value="300">5 hours</MenuItem>
                            <MenuItem value="420">7 hours</MenuItem>
                            <MenuItem value="720">12 hours</MenuItem>
                            <MenuItem value="1440">1 day</MenuItem>
                            <MenuItem value="4320">3 days</MenuItem>
                            <MenuItem value="7200">5 days</MenuItem>
                            <MenuItem value="10080">7 days</MenuItem>
                          </Select>
                        </FormControl>
                      </Box>
                      <Box>
                        <Typography
                          component="label"
                          sx={{
                            color: 'text.primary',
                            display: 'block',
                            fontSize: 13,
                            fontWeight: 700,
                            mb: 0.85,
                          }}
                        >
                          Maximum approval delay
                        </Typography>
                        <FormControl fullWidth sx={GROUP_MODAL_CONTROL_SX}>
                          <Select
                            value={maxBlock}
                            onChange={handleChangeMaxBlock}
                          >
                            <MenuItem value="60">1 hour</MenuItem>
                            <MenuItem value="180">3 hours</MenuItem>
                            <MenuItem value="300">5 hours</MenuItem>
                            <MenuItem value="420">7 hours</MenuItem>
                            <MenuItem value="720">12 hours</MenuItem>
                            <MenuItem value="1440">1 day</MenuItem>
                            <MenuItem value="4320">3 days</MenuItem>
                            <MenuItem value="7200">5 days</MenuItem>
                            <MenuItem value="10080">7 days</MenuItem>
                            <MenuItem value="14400">10 days</MenuItem>
                            <MenuItem value="21600">15 days</MenuItem>
                          </Select>
                        </FormControl>
                      </Box>
                    </Box>
                    <Box
                      sx={{
                        alignItems: 'center',
                        backgroundColor: '#0D0F14',
                        border: '1px solid rgba(255, 255, 255, 0.06)',
                        borderRadius: '8px',
                        color: 'text.secondary',
                        display: 'flex',
                        gap: 1,
                        p: 1.25,
                      }}
                    >
                      <InfoOutlinedIcon sx={{ fontSize: 18 }} />
                      <Typography sx={{ fontSize: 12, lineHeight: '17px' }}>
                        These settings affect group transactions and cannot be
                        changed after creation.
                      </Typography>
                    </Box>
                  </Box>
                </Collapse>
              </Box>
            </Box>
          )}

          {value === 2 && (
            <Box
              sx={{
                display: 'flex',
                flex: 1,
                minHeight: 0,
                overflow: 'auto',
                px: { xs: 2.5, sm: 4 },
                py: 2.5,
              }}
            >
              <UserListOfInvites
                myAddress={address}
                setOpenSnack={setOpenSnack}
                setInfoSnack={setInfoSnack}
              />
            </Box>
          )}
        </Box>

        <Box
          component="footer"
          sx={{
            alignItems: 'center',
            borderTop: '1px solid rgba(255, 255, 255, 0.1)',
            display: 'flex',
            gap: 1,
            justifyContent: 'flex-end',
            px: { xs: 2.5, sm: 4 },
            py: 1.5,
          }}
        >
          <Button
            disabled={isCreating}
            onClick={handleClose}
            sx={{
              borderRadius: '8px',
              color: 'text.secondary',
              fontWeight: 700,
              minHeight: 40,
              px: 2,
              textTransform: 'none',
              '&:hover': {
                backgroundColor: 'action.hover',
                color: 'text.primary',
              },
            }}
          >
            Cancel
          </Button>
          {value === 0 && (
            <Button
              disabled={!canCreateGroup}
              onClick={() => void handleCreateGroup()}
              variant="contained"
              sx={{
                backgroundColor: RETICULUM_ACTIVE_BLUE,
                borderRadius: '8px',
                color: 'common.white',
                fontWeight: 700,
                minHeight: 40,
                minWidth: 138,
                px: 2.25,
                textTransform: 'none',
                '&:hover': { backgroundColor: '#1e40af' },
                '&.Mui-disabled': {
                  backgroundColor: 'action.disabledBackground',
                  color: 'text.disabled',
                },
              }}
            >
              {isCreating ? 'Creating...' : 'Create Group'}
            </Button>
          )}
        </Box>

        <CustomizedSnackbars
          open={openSnack}
          setOpen={setOpenSnack}
          info={infoSnack}
          setInfo={setInfoSnack}
        />
      </Dialog>
    </Fragment>
  );
};
