import { download, fetchBlob } from '@/core/request/http'

/** 智能体产出的导出与文件：图表或报告表格导出 xlsx（只限会话本人）、生成的图片（本人名下的私有文件）。 */
export const agentOutputApi = {
  /** 图表的数据，或报告正文第 `table` 张表格（从 0 起） */
  xlsx: (itemId: number, filename: string, table?: number) =>
    download(`/agent/items/${itemId}/xlsx`, table == null ? {} : { table }, filename),
  /** 生成的图片内容（预览用） */
  image: (fileId: number) => fetchBlob(`/storage/objects/${fileId}/download`, { inline: true }),
}
