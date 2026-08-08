import { LoadingButton } from '@mui/lab';
import {
  alpha,
  Autocomplete,
  Box,
  CircularProgress,
  InputAdornment,
  MenuItem,
  Select,
  SelectChangeEvent,
  TextField,
  Typography,
  useTheme,
} from '@mui/material';
import AccessTimeRoundedIcon from '@mui/icons-material/AccessTimeRounded';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import KeyboardArrowDownRoundedIcon from '@mui/icons-material/KeyboardArrowDownRounded';
import SearchRoundedIcon from '@mui/icons-material/SearchRounded';
import SendRoundedIcon from '@mui/icons-material/SendRounded';
import { useMemo, useState } from 'react';
import { getFee } from '../../background/background.ts';
import { useTranslation } from 'react-i18next';
import { useNameSearch } from '../../hooks/useNameSearch';
import { hasInvisibleCharacters } from '../../utils/hasInvisibleCharacters';
import { validateAddress } from '../../utils/validateAddress';

export const InviteMember = ({ groupId, setInfoSnack, setOpenSnack, show }) => {
  const [value, setValue] = useState('');
  const [searchValue, setSearchValue] = useState('');
  const [expiryTime, setExpiryTime] = useState<string>('259200');
  const [isLoadingInvite, setIsLoadingInvite] = useState(false);
  const theme = useTheme();
  const { t } = useTranslation(['auth', 'core', 'group', 'question']);
  const searchQuery = searchValue.trim();
  const { results: nameSearchResults, isLoading: isLoadingNameSearch } =
    useNameSearch(searchQuery, 15);

  const nameOptions = useMemo(
    () =>
      nameSearchResults
        ?.map((item) => item.name)
        .filter((name) => !hasInvisibleCharacters(name)) ?? [],
    [nameSearchResults]
  );

  const inviteMember = async () => {
    const invitee = value.trim();

    if (!expiryTime || !invitee) {
      setInfoSnack({
        type: 'error',
        message: t('auth:message.generic.name_address', {
          postProcess: 'capitalizeFirstChar',
        }),
      });
      setOpenSnack(true);
      return;
    }

    if (!validateAddress(invitee) && hasInvisibleCharacters(invitee)) {
      setInfoSnack({
        type: 'error',
        message: 'Names with invisible characters cannot be invited.',
      });
      setOpenSnack(true);
      return;
    }

    try {
      const fee = await getFee('GROUP_INVITE');

      await show({
        message: t('core:message.question.perform_transaction', {
          action: 'GROUP_INVITE',
          postProcess: 'capitalizeFirstChar',
        }),
        publishFee: fee.fee + ' QORT',
      });

      setIsLoadingInvite(true);

      const response = await window.sendMessage('inviteToGroup', {
        groupId,
        qortalAddress: invitee,
        inviteTime: +expiryTime,
      });

      if (response?.error) {
        setInfoSnack({
          type: 'error',
          message: response.error,
        });
        setOpenSnack(true);
        return;
      }

      setInfoSnack({
        type: 'success',
        message: t('group:message.success.group_invite', {
          invitee,
          postProcess: 'capitalizeFirstChar',
        }),
      });
      setOpenSnack(true);
      setValue('');
      setSearchValue('');
    } catch (error) {
      setInfoSnack({
        type: 'error',
        message:
          (error instanceof Error ? error.message : '') ||
          t('core:message.error.generic', {
            postProcess: 'capitalizeFirstChar',
          }),
      });
      setOpenSnack(true);
    } finally {
      setIsLoadingInvite(false);
    }
  };

  const handleChange = (event: SelectChangeEvent) => {
    setExpiryTime(event.target.value as string);
  };

  const fieldBackground =
    theme.palette.mode === 'dark'
      ? alpha(theme.palette.common.black, 0.16)
      : alpha(theme.palette.common.black, 0.035);
  const fieldBorder = alpha(
    theme.palette.text.secondary,
    theme.palette.mode === 'dark' ? 0.34 : 0.28
  );
  const focusedBorder = alpha(theme.palette.primary.main, 0.68);

  const fieldSx = {
    backgroundColor: fieldBackground,
    borderRadius: '8px',
    color: 'text.primary',
    fontSize: 13,
    minHeight: 48,
    transition: 'border-color 150ms ease, background-color 150ms ease',
    '& .MuiOutlinedInput-notchedOutline': {
      borderColor: fieldBorder,
    },
    '&:hover': {
      backgroundColor: alpha(
        theme.palette.text.primary,
        theme.palette.mode === 'dark' ? 0.035 : 0.025
      ),
      '& .MuiOutlinedInput-notchedOutline': {
        borderColor: alpha(theme.palette.text.secondary, 0.52),
      },
    },
    '&.Mui-focused .MuiOutlinedInput-notchedOutline': {
      borderColor: focusedBorder,
      borderWidth: '1px',
    },
  };

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        px: 0.75,
        py: 1,
      }}
    >
      <Box
        sx={{
          alignItems: 'flex-start',
          borderBottom: `1px solid ${alpha(theme.palette.divider, 0.72)}`,
          display: 'flex',
          gap: 1.25,
          pb: 2,
        }}
      >
        <Box
          sx={{
            alignItems: 'center',
            backgroundColor: alpha(theme.palette.primary.main, 0.3),
            border: `1px solid ${alpha(theme.palette.primary.main, 0.18)}`,
            borderRadius: '50%',
            color: theme.palette.mode === 'dark' ? '#eaf2ff' : '#ffffff',
            display: 'flex',
            flex: '0 0 auto',
            height: 42,
            justifyContent: 'center',
            mt: 0.1,
            width: 42,
          }}
        >
          <SendRoundedIcon sx={{ fontSize: 21, transform: 'rotate(-12deg)' }} />
        </Box>
        <Box sx={{ minWidth: 0, pt: 0.2 }}>
          <Typography
            sx={{
              color: 'text.primary',
              fontSize: 15,
              fontWeight: 700,
              lineHeight: '20px',
            }}
          >
            Invite members
          </Typography>
          <Typography
            sx={{
              color: 'text.secondary',
              fontSize: 12.5,
              lineHeight: '17px',
              mt: 0.35,
            }}
          >
            Send an invitation to a Qortal name or address.
          </Typography>
        </Box>
      </Box>

      <Typography
        component="label"
        sx={{
          color: 'text.secondary',
          fontSize: 10.5,
          fontWeight: 700,
          letterSpacing: '0.075em',
          lineHeight: '16px',
          mb: 0.75,
          mt: 2,
          textTransform: 'uppercase',
        }}
      >
        Invite to
      </Typography>
      <Autocomplete
        freeSolo
        value={value}
        inputValue={searchValue}
        loading={isLoadingNameSearch}
        noOptionsText={t('core:option_no', {
          postProcess: 'capitalizeFirstChar',
        })}
        options={nameOptions}
        onChange={(_event, newValue) => {
          const nextValue = typeof newValue === 'string' ? newValue.trim() : '';
          setValue(nextValue);
          setSearchValue(nextValue);
        }}
        onInputChange={(_event, newInputValue) => {
          setSearchValue(newInputValue);
          setValue(newInputValue);
        }}
        renderInput={(params) => (
          <TextField
            {...params}
            placeholder="Name or address"
            InputProps={{
              ...params.InputProps,
              startAdornment: (
                <>
                  <InputAdornment position="start">
                    <SearchRoundedIcon
                      sx={{ color: 'text.secondary', fontSize: 20 }}
                    />
                  </InputAdornment>
                  {params.InputProps.startAdornment}
                </>
              ),
              endAdornment: (
                <>
                  {isLoadingNameSearch ? (
                    <CircularProgress color="inherit" size={16} />
                  ) : null}
                  {params.InputProps.endAdornment}
                </>
              ),
            }}
            sx={{
              '& .MuiOutlinedInput-root': {
                ...fieldSx,
                py: 0,
              },
              '& .MuiInputBase-input': {
                fontSize: 13,
                py: '12px',
              },
            }}
          />
        )}
      />

      <Box sx={{ mt: 2 }}>
        <Typography
          component="label"
          htmlFor="reticulum-invite-expiry"
          sx={{
            color: 'text.secondary',
            display: 'block',
            fontSize: 10.5,
            fontWeight: 700,
            letterSpacing: '0.075em',
            lineHeight: '16px',
            mb: 0.75,
            textTransform: 'uppercase',
          }}
        >
          {t('group:invitation_expiry', { postProcess: 'capitalizeFirstChar' })}
        </Typography>
        <Select
          fullWidth
          id="reticulum-invite-expiry"
          value={expiryTime}
          onChange={handleChange}
          IconComponent={KeyboardArrowDownRoundedIcon}
          startAdornment={
            <InputAdornment position="start">
              <AccessTimeRoundedIcon
                sx={{ color: 'text.secondary', fontSize: 20 }}
              />
            </InputAdornment>
          }
          MenuProps={{
            PaperProps: {
              sx: {
                backgroundColor: 'background.surface',
                border: `1px solid ${alpha(theme.palette.divider, 0.8)}`,
                backgroundImage: 'none',
                mt: 0.5,
              },
            },
          }}
          sx={{
            ...fieldSx,
            height: 48,
            '& .MuiSelect-select': {
              alignItems: 'center',
              display: 'flex',
              py: 0,
            },
            '& .MuiSelect-icon': {
              color: 'text.secondary',
              right: 10,
            },
          }}
        >
          <MenuItem value={10800}>{t('core:time.hour', { count: 3 })}</MenuItem>
          <MenuItem value={21600}>{t('core:time.hour', { count: 6 })}</MenuItem>
          <MenuItem value={43200}>
            {t('core:time.hour', { count: 12 })}
          </MenuItem>
          <MenuItem value={86400}>{t('core:time.day', { count: 1 })}</MenuItem>
          <MenuItem value={259200}>{t('core:time.day', { count: 3 })}</MenuItem>
          <MenuItem value={432000}>{t('core:time.day', { count: 5 })}</MenuItem>
          <MenuItem value={604800}>{t('core:time.day', { count: 7 })}</MenuItem>
          <MenuItem value={864000}>
            {t('core:time.day', { count: 10 })}
          </MenuItem>
          <MenuItem value={1296000}>
            {t('core:time.day', { count: 15 })}
          </MenuItem>
          <MenuItem value={2592000}>
            {t('core:time.day', { count: 30 })}
          </MenuItem>
        </Select>
      </Box>

      <Box
        sx={{
          alignItems: 'flex-start',
          backgroundColor: alpha(
            theme.palette.text.primary,
            theme.palette.mode === 'dark' ? 0.045 : 0.035
          ),
          border: `1px solid ${alpha(theme.palette.divider, 0.58)}`,
          borderRadius: '8px',
          display: 'flex',
          gap: 1,
          mt: 2,
          px: 1.25,
          py: 1.25,
        }}
      >
        <InfoOutlinedIcon
          sx={{
            color: 'text.secondary',
            flexShrink: 0,
            fontSize: 18,
            mt: 0.05,
          }}
        />
        <Typography
          sx={{ color: 'text.secondary', fontSize: 12, lineHeight: '17px' }}
        >
          The invitation link will expire after the selected time.
        </Typography>
      </Box>

      <LoadingButton
        variant="contained"
        loadingPosition="start"
        loading={isLoadingInvite}
        onClick={inviteMember}
        sx={{
          alignSelf: 'flex-start',
          borderRadius: '8px',
          boxShadow: 'none',
          fontSize: 13,
          fontWeight: 650,
          minHeight: 39,
          mt: 2,
          px: 2.5,
          textTransform: 'none',
          '&:hover': { boxShadow: 'none' },
        }}
      >
        {t('core:action.invite', { postProcess: 'capitalizeFirstChar' })}
      </LoadingButton>
    </Box>
  );
};
