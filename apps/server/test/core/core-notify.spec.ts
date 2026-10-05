import {
  fillTemplate,
  NotifyChannels,
  NotifyDispatcher,
  type NotifyChannel,
} from '../../src/core/notify/notify.js'

describe('fillTemplate', () => {
  it('replaces known and repeated names, leaving unknown names intact', () => {
    expect(fillTemplate('{a}/{a}/{x}', { a: 'yes' })).toBe('yes/yes/{x}')
  })

  it('escapes substituted HTML values only when requested', () => {
    const text = '<i>{a}</i>'
    const values = { a: `<b>&"'` }
    expect(fillTemplate(text, values)).toBe(`<i><b>&"'</i>`)
    expect(fillTemplate(text, values, true)).toBe('<i>&lt;b&gt;&amp;&quot;&#39;</i>')
  })

  it('keeps replacement-string specials literal and never expands a replacement again', () => {
    expect(fillTemplate('{a}/{b}', { a: '$&/$1/{b}', b: 'done' })).toBe('$&/$1/{b}/done')
  })

  it('does not treat inherited property names as supplied values', () => {
    expect(fillTemplate('{constructor}', {})).toBe('{constructor}')
  })
})

describe('NotifyChannels', () => {
  it('registers, looks up and lists channels; rejects a duplicate code', () => {
    const registry = new NotifyChannels()
    const inbox = { code: 'inbox' } as NotifyChannel
    const mail = { code: 'mail' } as NotifyChannel
    expect(registry.get('inbox')).toBeUndefined()
    expect(registry.all()).toEqual([])
    registry.register(inbox)
    registry.register(mail)
    expect(registry.get('inbox')).toBe(inbox)
    expect(registry.get('sms')).toBeUndefined()
    expect(registry.all()).toEqual([inbox, mail])
    expect(() => registry.register({ code: 'inbox' } as NotifyChannel)).toThrow(
      /already registered/,
    )
    expect(registry.all()).toEqual([inbox, mail])
  })
})

describe('NotifyDispatcher', () => {
  it('delivers rows sequentially within a channel while channels run together', async () => {
    const starts: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const channels = new NotifyChannels()
    channels.register({
      code: 'inbox',
      deliver: async (id: number) => {
        starts.push(`inbox:${id}`)
        if (id === 1) await gate
      },
    } as NotifyChannel)
    channels.register({
      code: 'mail',
      deliver: async (id: number) => {
        starts.push(`mail:${id}`)
      },
    } as NotifyChannel)
    const flushed = new NotifyDispatcher(channels).flush({ inbox: [1, 2], mail: [3] })
    expect(starts).toEqual(['inbox:1', 'mail:3'])
    release()
    await flushed
    expect(starts).toEqual(['inbox:1', 'mail:3', 'inbox:2'])
  })
})
