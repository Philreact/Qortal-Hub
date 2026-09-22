import {
  dispatchQAppReticulumRequest,
  isQAppReticulumAction,
} from './qapp-reticulum-request';
import {
  dispatchQAppPrivateChannelRequest,
  isQAppPrivateChannelAction,
} from './qapp-private-channel-request';
import { dispatchQAppMoqRequest, isQAppMoqAction } from './qapp-moq-request';

type HostRequest = {
  action: string;
  payload: unknown;
  timeout: number;
  isExtension: boolean;
  appInfo: {
    name: string;
    service: string;
    tabId: string;
    hostRequestId: string;
  };
};

export function isQAppHostBackendAction(action: unknown): action is string {
  return (
    isQAppReticulumAction(action) ||
    isQAppPrivateChannelAction(action) ||
    isQAppMoqAction(action)
  );
}

export function dispatchQAppHostRequest(
  request: HostRequest
): Promise<unknown> {
  const context = {
    appName: request.appInfo.name,
    appService: request.appInfo.service,
    tabId: request.appInfo.tabId,
    hostRequestId: request.appInfo.hostRequestId,
    isFromExtension: request.isExtension,
  };
  const backendMessage = {
    ...(request.payload && typeof request.payload === 'object'
      ? request.payload
      : {}),
    action: request.action,
  };
  if (isQAppReticulumAction(request.action))
    return dispatchQAppReticulumRequest(backendMessage, context);
  if (isQAppPrivateChannelAction(request.action))
    return dispatchQAppPrivateChannelRequest(backendMessage, context);
  if (isQAppMoqAction(request.action))
    return dispatchQAppMoqRequest(backendMessage, context);
  return window.sendMessage(
    request.action,
    request.payload,
    request.timeout,
    request.isExtension,
    request.appInfo
  );
}
