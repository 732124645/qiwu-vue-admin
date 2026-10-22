import { Injectable } from '@nestjs/common'

/** 服务端时钟端口仅供进程内测试替换；请求参数永远不能提供打卡时间。 */
@Injectable()
export class ClockTime {
  now(): Date {
    return new Date()
  }
}

/** 以规则的 IANA 时区计算自然工作日，避免本机时区和客户端时区参与判断。 */
export function workDateAt(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)!.value
  return `${value('year')}-${value('month')}-${value('day')}`
}

/** 球面距离仅用于现场范围判断；比较使用未取整结果，展示和落库时才取整。 */
export function distanceMeters(
  latitude: number,
  longitude: number,
  siteLatitude: number,
  siteLongitude: number,
): number {
  const rad = (degrees: number) => (degrees * Math.PI) / 180
  const a =
    Math.sin(rad(latitude - siteLatitude) / 2) ** 2 +
    Math.cos(rad(latitude)) *
      Math.cos(rad(siteLatitude)) *
      Math.sin(rad(longitude - siteLongitude) / 2) ** 2
  return 6371008.8 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, a))))
}
