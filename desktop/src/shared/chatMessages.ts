export type ChatContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }
export type ChatMessage<Content = string> = { role: 'system' | 'user' | 'assistant'; content: Content }
export type MultimodalChatMessage = ChatMessage<string | ChatContentPart[]>
