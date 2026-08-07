import { useCallback, useRef } from 'react';
import { getBaseApiReact } from '../App';

export const useHandleUserInfo = () => {
  const userInfoRef = useRef({});
  const pendingUserInfoRef = useRef<Record<string, Promise<any>>>({});

  const getIndividualUserInfo = useCallback(async (address) => {
    try {
      if (!address) return null;
      if (userInfoRef.current[address] !== undefined)
        return userInfoRef.current[address];
      if (pendingUserInfoRef.current[address]) {
        return pendingUserInfoRef.current[address];
      }

      const request = (async () => {
        const url = `${getBaseApiReact()}/addresses/${address}`;
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error('network error');
        }
        const data = await response.json();
        userInfoRef.current[address] = data?.level;
        return data?.level;
      })();
      pendingUserInfoRef.current[address] = request;
      try {
        return await request;
      } finally {
        delete pendingUserInfoRef.current[address];
      }
    } catch (error) {
      console.log(error);
    }
  }, []);

  return getIndividualUserInfo;
};
