import { LoadingButton } from '@mui/lab';
import {
  Autocomplete,
  Box,
  CircularProgress,
  MenuItem,
  Select,
  SelectChangeEvent,
  TextField,
} from '@mui/material';
import { useMemo, useState } from 'react';
import { Spacer } from '../../common/Spacer';
import { getFee } from '../../background/background.ts';
import { useTranslation } from 'react-i18next';
import { Label } from '../../styles/App-styles.ts';
import { useNameSearch } from '../../hooks/useNameSearch';
import { hasInvisibleCharacters } from '../../utils/hasInvisibleCharacters';
import { validateAddress } from '../../utils/validateAddress';

export const InviteMember = ({ groupId, setInfoSnack, setOpenSnack, show }) => {
  const [value, setValue] = useState('');
  const [searchValue, setSearchValue] = useState('');
  const [expiryTime, setExpiryTime] = useState<string>('259200');
  const [isLoadingInvite, setIsLoadingInvite] = useState(false);
  const { t } = useTranslation([
    'auth',
    'core',
    'group',
    'question',
    'tutorial',
  ]);
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

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {t('group:action.invite_member', { postProcess: 'capitalizeFirstChar' })}

      <Spacer height="20px" />

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
          const nextValue =
            typeof newValue === 'string' ? newValue.trim() : '';
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
            variant="standard"
            placeholder={t('auth:message.generic.name_address', {
              postProcess: 'capitalizeFirstChar',
            })}
            InputProps={{
              ...params.InputProps,
              endAdornment: (
                <>
                  {isLoadingNameSearch ? (
                    <CircularProgress color="inherit" size={16} />
                  ) : null}
                  {params.InputProps.endAdornment}
                </>
              ),
            }}
          />
        )}
      />

      <Spacer height="20px" />

      <Label>
        {t('group:invitation_expiry', { postProcess: 'capitalizeFirstChar' })}
      </Label>

      <Select
        labelId="demo-simple-select-label"
        id="demo-simple-select"
        value={expiryTime}
        label={t('group:invitation_expiry', {
          postProcess: 'capitalizeFirstChar',
        })}
        onChange={handleChange}
      >
        <MenuItem value={10800}>{t('core:time.hour', { count: 3 })}</MenuItem>
        <MenuItem value={21600}>{t('core:time.hour', { count: 6 })}</MenuItem>
        <MenuItem value={43200}>{t('core:time.hour', { count: 12 })}</MenuItem>
        <MenuItem value={86400}>{t('core:time.day', { count: 1 })}</MenuItem>
        <MenuItem value={259200}>{t('core:time.day', { count: 3 })}</MenuItem>
        <MenuItem value={432000}>{t('core:time.day', { count: 5 })}</MenuItem>
        <MenuItem value={604800}>{t('core:time.day', { count: 7 })}</MenuItem>
        <MenuItem value={864000}>{t('core:time.day', { count: 10 })}</MenuItem>
        <MenuItem value={1296000}>{t('core:time.day', { count: 15 })}</MenuItem>
        <MenuItem value={2592000}>{t('core:time.day', { count: 30 })}</MenuItem>
      </Select>

      <Spacer height="20px" />

      <LoadingButton
        variant="contained"
        loadingPosition="start"
        loading={isLoadingInvite}
        onClick={inviteMember}
      >
        {t('core:action.invite', { postProcess: 'capitalizeFirstChar' })}
      </LoadingButton>
    </Box>
  );
};
