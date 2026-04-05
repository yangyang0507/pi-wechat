export interface Credentials {
  token: string
  baseUrl: string
  accountId: string
  userId: string
  savedAt?: string
}

export interface BaseInfo {
  channel_version: string
}

export enum MessageType {
  USER = 1,
  BOT = 2
}

export enum MessageState {
  NEW = 0,
  GENERATING = 1,
  FINISH = 2
}

export enum MessageItemType {
  TEXT = 1,
  IMAGE = 2,
  VOICE = 3,
  FILE = 4,
  VIDEO = 5
}

export interface TextItem {
  text: string
}

export interface ImageItem {
  url?: string
}

export interface VoiceItem {
  text?: string
}

export interface FileItem {
  file_name?: string
}

export interface VideoItem {
  url?: string
}

export interface MessageItem {
  type: MessageItemType
  text_item?: TextItem
  image_item?: ImageItem
  voice_item?: VoiceItem
  file_item?: FileItem
  video_item?: VideoItem
}

export interface WeixinMessage {
  message_id: string | number
  from_user_id: string
  to_user_id: string
  client_id: string
  create_time_ms: number
  message_type: MessageType
  message_state: MessageState
  context_token: string
  item_list: MessageItem[]
}

export interface GetUpdatesReq {
  get_updates_buf: string
  base_info: BaseInfo
}

export interface GetUpdatesResp {
  ret: number
  msgs: WeixinMessage[]
  get_updates_buf: string
  longpolling_timeout_ms?: number
  errcode?: number
  errmsg?: string
}

export interface SendMessageReq {
  msg: {
    from_user_id: string
    to_user_id: string
    client_id: string
    message_type: MessageType
    message_state: MessageState
    context_token: string
    item_list: MessageItem[]
  }
  base_info: BaseInfo
}

export interface SendTypingReq {
  ilink_user_id: string
  typing_ticket: string
  status: 1 | 2
  base_info: BaseInfo
}

export interface GetConfigResp {
  typing_ticket?: string
  ret?: number
  errcode?: number
  errmsg?: string
}

export type IncomingMessageType = 'text' | 'image' | 'voice' | 'file' | 'video'

export interface IncomingMessage {
  messageId: string
  userId: string
  text: string
  type: IncomingMessageType
  raw: WeixinMessage
  contextToken: string
  timestamp: Date
}

export interface QueuedWechatRequest {
  id: string
  userId: string
  messageId: string
  receivedAt: Date
  text: string
  preview: string
}
