import {
  Fragment,
  SyntheticEvent,
  useContext,
  useEffect,
  useState,
} from 'react';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import AppBar from '@mui/material/AppBar';
import Toolbar from '@mui/material/Toolbar';
import IconButton from '@mui/material/IconButton';
import Typography from '@mui/material/Typography';
import CloseIcon from '@mui/icons-material/Close';
import ExpandLess from '@mui/icons-material/ExpandLess';
import ExpandMore from '@mui/icons-material/ExpandMore';
import AddRoundedIcon from '@mui/icons-material/AddRounded';
import SearchRoundedIcon from '@mui/icons-material/SearchRounded';
import CheckRoundedIcon from '@mui/icons-material/CheckRounded';
import {
  Box,
  Collapse,
  FormControl,
  MenuItem,
  Select,
  SelectChangeEvent,
  Tab,
  Tabs,
  TextField,
  useTheme,
} from '@mui/material';
import { AddGroupList } from './AddGroupList';
import { UserListOfInvites } from './UserListOfInvites';
import { CustomizedSnackbars } from '../Snackbar/Snackbar';
import { getFee } from '../../background/background.ts';
import { QORTAL_APP_CONTEXT } from '../../App';
import { subscribeToEvent, unsubscribeFromEvent } from '../../utils/events';
import { useTranslation } from 'react-i18next';
import { useSetAtom } from 'jotai';
import { txListAtom } from '../../atoms/global';

const RETICULUM_ACTIVE_BLUE = '#2563eb';

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

  const handleChange = (event: SyntheticEvent, newValue: number) => {
    setValue(newValue);
  };

  const handleClose = () => {
    setOpen(false);
  };

  const handleChangeGroupType = (event: SelectChangeEvent) => {
    setGroupType(event.target.value as string);
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
  const theme = useTheme();

  const handleCreateGroup = async () => {
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
    }
  };

  function a11yProps(index: number) {
    return {
      id: `simple-tab-${index}`,
      'aria-controls': `simple-tabpanel-${index}`,
    };
  }

  const openGroupInvitesRequestFunc = () => {
    setValue(2);
  };

  const openFindGroupRequestFunc = () => {
    setValue(1);
  };

  const tabItems = [
    {
      icon: <AddRoundedIcon sx={{ fontSize: 22 }} />,
      label: t('group:action.create_group', {
        postProcess: 'capitalizeFirstChar',
      }),
    },
    {
      icon: <SearchRoundedIcon sx={{ fontSize: 21 }} />,
      label: t('group:action.find_group', {
        postProcess: 'capitalizeFirstChar',
      }),
    },
    {
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
    subscribeToEvent('openFindGroupRequest', openFindGroupRequestFunc);

    return () => {
      unsubscribeFromEvent(
        'openGroupInvitesRequest',
        openGroupInvitesRequestFunc
      );
      unsubscribeFromEvent(
        'openFindGroupRequest',
        openFindGroupRequestFunc
      );
    };
  }, []);

  if (!open) return null;

  return (
    <Fragment>
      <Dialog
        open={open}
        onClose={handleClose}
        fullWidth
        maxWidth="md"
        PaperProps={{
          sx: {
            bgcolor: theme.palette.background.default,
            border: `1px solid ${theme.palette.divider}`,
            borderRadius: '12px',
            boxShadow: '0 24px 70px rgba(0,0,0,0.42)',
            height: 'min(760px, calc(100vh - 80px))',
            maxHeight: 'calc(100vh - 80px)',
            overflow: 'hidden',
          },
        }}
      >
        <AppBar
          position="relative"
          elevation={0}
          sx={{
            bgcolor: theme.palette.background.paper,
            borderBottom: `1px solid ${theme.palette.divider}`,
            color: theme.palette.text.primary,
          }}
        >
          <Toolbar sx={{ minHeight: { xs: 56, sm: 64 }, px: { xs: 1, sm: 2 } }}>
            <Typography
              sx={{
                flex: 1,
                fontSize: { xs: '1rem', sm: '1.05rem' },
                fontWeight: 800,
                letterSpacing: 0,
              }}
              variant="h6"
              component="div"
            >
              {t('group:group.management', {
                postProcess: 'capitalizeFirstChar',
              })}
            </Typography>

            <IconButton
              aria-label={t('core:action.close', {
                postProcess: 'capitalizeFirstChar',
              })}
              onClick={handleClose}
              sx={{
                bgcolor: theme.palette.action.hover,
                color: theme.palette.text.primary,
                '&:hover': {
                  bgcolor: theme.palette.action.selected,
                },
              }}
            >
              <CloseIcon />
            </IconButton>
          </Toolbar>
        </AppBar>

        <Box
          sx={{
            bgcolor: theme.palette.background.default,
            color: theme.palette.text.primary,
            display: 'flex',
            flexDirection: 'column',
            flexGrow: 1,
            overflowY: 'auto',
          }}
        >
          <Tabs
            value={value}
            onChange={handleChange}
            centered
            sx={{
              borderBottom: `1px solid ${theme.palette.divider}`,
              minHeight: 58,
              '& .MuiTabs-flexContainer': {
                gap: 1,
                justifyContent: 'center',
                py: 1,
              },
              '& .MuiTab-root': {
                borderRadius: '8px',
                color: theme.palette.text.secondary,
                minHeight: 38,
                minWidth: 46,
                px: 1.5,
                transition: 'background-color 140ms ease, color 140ms ease',
                '&.Mui-selected': {
                  backgroundColor: RETICULUM_ACTIVE_BLUE,
                  color: theme.palette.common.white,
                },
                '&:hover': {
                  backgroundColor: theme.palette.action.hover,
                  color: theme.palette.text.primary,
                },
                '&.Mui-selected:hover': {
                  backgroundColor: RETICULUM_ACTIVE_BLUE,
                  color: theme.palette.common.white,
                },
              },
              '& .MuiTabs-indicator': {
                display: 'none',
              },
            }}
          >
            {tabItems.map((item, index) => (
              <Tab
                aria-label={item.label}
                icon={item.icon}
                key={item.label}
                title={item.label}
                {...a11yProps(index)}
              />
            ))}
          </Tabs>
          <Box
            sx={{
              alignItems: 'center',
              display: 'flex',
              gap: 1.25,
              justifyContent: 'center',
              px: 3,
              pt: 2.5,
            }}
          >
            <Typography
              sx={{
                fontSize: 20,
                fontWeight: 800,
                textAlign: 'center',
              }}
            >
              {tabItems[value]?.label}
            </Typography>
          </Box>

          {value === 0 && (
            <Box
              sx={{
                width: '100%',
                p: { xs: 2, sm: 3 },
                display: 'flex',
                justifyContent: 'center',
              }}
            >
              <Box
                sx={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 3,
                  maxWidth: 480,
                  width: '100%',
                }}
              >
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
                  <Typography
                    component="label"
                    variant="body2"
                    sx={{
                      color: theme.palette.text.primary,
                      fontWeight: 600,
                      letterSpacing: '0.02em',
                    }}
                  >
                    {t('group:group.name', {
                      postProcess: 'capitalizeFirstChar',
                    })}
                  </Typography>
                  <TextField
                    placeholder={t('group:group.name', {
                      postProcess: 'capitalizeFirstChar',
                    })}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    inputProps={{ maxLength: 32 }}
                    variant="outlined"
                    fullWidth
                    helperText={`${name?.length || 0}/32`}
                    sx={{
                      '& .MuiOutlinedInput-root': {
                        borderRadius: 2,
                        bgcolor: theme.palette.background.paper,
                        '&:hover .MuiOutlinedInput-notchedOutline': {
                          borderColor: theme.palette.action.hover,
                        },
                        '&.Mui-focused .MuiOutlinedInput-notchedOutline': {
                          borderWidth: 2,
                        },
                      },
                    }}
                  />
                </Box>

                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
                  <Typography
                    component="label"
                    variant="body2"
                    sx={{
                      color: theme.palette.text.primary,
                      fontWeight: 600,
                      letterSpacing: '0.02em',
                    }}
                  >
                    {t('group:group.description', {
                      postProcess: 'capitalizeFirstChar',
                    })}
                  </Typography>
                  <TextField
                    placeholder={t('group:group.description', {
                      postProcess: 'capitalizeFirstChar',
                    })}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    inputProps={{ maxLength: 120 }}
                    variant="outlined"
                    fullWidth
                    multiline
                    minRows={2}
                    helperText={`${description?.length || 0}/120`}
                    sx={{
                      '& .MuiOutlinedInput-root': {
                        borderRadius: 2,
                        bgcolor: theme.palette.background.paper,
                        '&:hover .MuiOutlinedInput-notchedOutline': {
                          borderColor: theme.palette.action.hover,
                        },
                        '&.Mui-focused .MuiOutlinedInput-notchedOutline': {
                          borderWidth: 2,
                        },
                      },
                    }}
                  />
                </Box>

                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
                  <Typography
                    component="label"
                    variant="body2"
                    sx={{
                      color: theme.palette.text.primary,
                      fontWeight: 600,
                      letterSpacing: '0.02em',
                    }}
                  >
                    {t('group:group.type', {
                      postProcess: 'capitalizeFirstChar',
                    })}
                  </Typography>
                  <FormControl
                    fullWidth
                    variant="outlined"
                    sx={{
                      '& .MuiOutlinedInput-root': {
                        borderRadius: 2,
                        bgcolor: theme.palette.background.paper,
                        '&:hover .MuiOutlinedInput-notchedOutline': {
                          borderColor: theme.palette.action.hover,
                        },
                        '&.Mui-focused .MuiOutlinedInput-notchedOutline': {
                          borderWidth: 2,
                        },
                      },
                    }}
                  >
                    <Select
                      value={groupType}
                      onChange={handleChangeGroupType}
                      fullWidth
                      displayEmpty
                    >
                      <MenuItem value="1">
                        {t('group:group.open', {
                          postProcess: 'capitalizeFirstChar',
                        })}
                      </MenuItem>
                      <MenuItem value="0">
                        {t('group:group.closed', {
                          postProcess: 'capitalizeFirstChar',
                        })}
                      </MenuItem>
                    </Select>
                  </FormControl>
                </Box>

                <Box
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setOpenAdvance((prev) => !prev);
                    }
                  }}
                  sx={{
                    alignItems: 'center',
                    cursor: 'pointer',
                    display: 'flex',
                    gap: 1,
                    py: 1,
                    px: 1.5,
                    borderRadius: 2,
                    bgcolor: theme.palette.action.hover,
                    '&:hover': {
                      bgcolor: theme.palette.action.selected,
                    },
                  }}
                  onClick={() => setOpenAdvance((prev) => !prev)}
                >
                  <Typography variant="body2" fontWeight={500}>
                    {t('group:advanced_options', {
                      postProcess: 'capitalizeFirstChar',
                    })}
                  </Typography>
                  {openAdvance ? <ExpandLess /> : <ExpandMore />}
                </Box>

                <Collapse in={openAdvance} timeout="auto" unmountOnExit>
                  <Box
                    sx={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 2.5,
                      p: 2,
                      borderRadius: 2,
                      bgcolor: theme.palette.background.paper,
                      border: `1px solid ${theme.palette.divider}`,
                    }}
                  >
                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
                      <Typography
                        component="label"
                        variant="body2"
                        sx={{
                          color: theme.palette.text.primary,
                          fontWeight: 600,
                          letterSpacing: '0.02em',
                        }}
                      >
                        {t('group:message.generic.group_approval_threshold', {
                          postProcess: 'capitalizeFirstChar',
                        })}
                      </Typography>
                      <FormControl
                        fullWidth
                        variant="outlined"
                        sx={{
                          '& .MuiOutlinedInput-root': {
                            borderRadius: 2,
                            bgcolor: theme.palette.background.default,
                          },
                        }}
                      >
                        <Select
                          value={approvalThreshold}
                          onChange={handleChangeApprovalThreshold}
                          fullWidth
                          displayEmpty
                        >
                          <MenuItem value="0">
                            {t('core:count.none', {
                              postProcess: 'capitalizeFirstChar',
                            })}
                          </MenuItem>
                          <MenuItem value="1">
                            {t('core:count.one', {
                              postProcess: 'capitalizeFirstChar',
                            })}
                          </MenuItem>
                          <MenuItem value="20">20%</MenuItem>
                          <MenuItem value="40">40%</MenuItem>
                          <MenuItem value="60">60%</MenuItem>
                          <MenuItem value="80">80%</MenuItem>
                          <MenuItem value="100">100%</MenuItem>
                        </Select>
                      </FormControl>
                    </Box>

                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
                      <Typography
                        component="label"
                        variant="body2"
                        sx={{
                          color: theme.palette.text.primary,
                          fontWeight: 600,
                          letterSpacing: '0.02em',
                        }}
                      >
                        {t('group:message.generic.block_delay_minimum', {
                          postProcess: 'capitalizeFirstChar',
                        })}
                      </Typography>
                      <FormControl
                        fullWidth
                        variant="outlined"
                        sx={{
                          '& .MuiOutlinedInput-root': {
                            borderRadius: 2,
                            bgcolor: theme.palette.background.default,
                          },
                        }}
                      >
                        <Select
                          value={minBlock}
                          onChange={handleChangeMinBlock}
                          fullWidth
                          displayEmpty
                        >
                          <MenuItem value="5">
                            {t('core:time.minute', { count: 5 })}
                          </MenuItem>
                          <MenuItem value="10">
                            {t('core:time.minute', { count: 10 })}
                          </MenuItem>
                          <MenuItem value="30">
                            {t('core:time.minute', { count: 30 })}
                          </MenuItem>
                          <MenuItem value="60">
                            {t('core:time.hour', { count: 1 })}
                          </MenuItem>
                          <MenuItem value="180">
                            {t('core:time.hour', { count: 3 })}
                          </MenuItem>
                          <MenuItem value="300">
                            {t('core:time.hour', { count: 5 })}
                          </MenuItem>
                          <MenuItem value="420">
                            {t('core:time.hour', { count: 7 })}
                          </MenuItem>
                          <MenuItem value="720">
                            {t('core:time.hour', { count: 12 })}
                          </MenuItem>
                          <MenuItem value="1440">
                            {t('core:time.day', { count: 1 })}
                          </MenuItem>
                          <MenuItem value="4320">
                            {t('core:time.day', { count: 3 })}
                          </MenuItem>
                          <MenuItem value="7200">
                            {t('core:time.day', { count: 5 })}
                          </MenuItem>
                          <MenuItem value="10080">
                            {t('core:time.day', { count: 7 })}
                          </MenuItem>
                        </Select>
                      </FormControl>
                    </Box>

                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
                      <Typography
                        component="label"
                        variant="body2"
                        sx={{
                          color: theme.palette.text.primary,
                          fontWeight: 600,
                          letterSpacing: '0.02em',
                        }}
                      >
                        {t('group:message.generic.block_delay_maximum', {
                          postProcess: 'capitalizeFirstChar',
                        })}
                      </Typography>
                      <FormControl
                        fullWidth
                        variant="outlined"
                        sx={{
                          '& .MuiOutlinedInput-root': {
                            borderRadius: 2,
                            bgcolor: theme.palette.background.default,
                          },
                        }}
                      >
                        <Select
                          value={maxBlock}
                          onChange={handleChangeMaxBlock}
                          fullWidth
                          displayEmpty
                        >
                          <MenuItem value="60">
                            {t('core:time.hour', { count: 1 })}
                          </MenuItem>
                          <MenuItem value="180">
                            {t('core:time.hour', { count: 3 })}
                          </MenuItem>
                          <MenuItem value="300">
                            {t('core:time.hour', { count: 5 })}
                          </MenuItem>
                          <MenuItem value="420">
                            {t('core:time.hour', { count: 7 })}
                          </MenuItem>
                          <MenuItem value="720">
                            {t('core:time.hour', { count: 12 })}
                          </MenuItem>
                          <MenuItem value="1440">
                            {t('core:time.day', { count: 1 })}
                          </MenuItem>
                          <MenuItem value="4320">
                            {t('core:time.day', { count: 3 })}
                          </MenuItem>
                          <MenuItem value="7200">
                            {t('core:time.day', { count: 5 })}
                          </MenuItem>
                          <MenuItem value="10080">
                            {t('core:time.day', { count: 7 })}
                          </MenuItem>
                          <MenuItem value="14400">
                            {t('core:time.day', { count: 10 })}
                          </MenuItem>
                          <MenuItem value="21600">
                            {t('core:time.day', { count: 15 })}
                          </MenuItem>
                        </Select>
                      </FormControl>
                    </Box>
                  </Box>
                </Collapse>

                <Button
                  variant="contained"
                  onClick={handleCreateGroup}
                  fullWidth
                  sx={{
                    backgroundColor: RETICULUM_ACTIVE_BLUE,
                    color: theme.palette.common.white,
                    py: 1.5,
                    mt: 0.5,
                    borderRadius: 2,
                    textTransform: 'uppercase',
                    fontWeight: 600,
                    letterSpacing: '0.08em',
                    boxShadow: theme.shadows[2],
                    '&:hover': {
                      backgroundColor: '#1e40af',
                      boxShadow: theme.shadows[4],
                    },
                  }}
                >
                  {t('group:action.create_group', {
                    postProcess: 'capitalizeFirstChar',
                  })}
                </Button>
              </Box>
            </Box>
          )}

          {value === 1 && (
            <Box
              sx={{
                display: 'flex',
                flexDirection: 'column',
                flexGrow: 1,
                p: { xs: 2, sm: 3 },
                width: '100%',
              }}
            >
              <AddGroupList
                setOpenSnack={setOpenSnack}
                setInfoSnack={setInfoSnack}
              />
            </Box>
          )}

          {value === 2 && (
            <Box
              sx={{
                display: 'flex',
                flexDirection: 'column',
                flexGrow: 1,
                p: { xs: 2, sm: 3 },
                width: '100%',
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
