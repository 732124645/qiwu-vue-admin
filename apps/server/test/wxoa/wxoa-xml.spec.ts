// Push bodies and passive replies. The bodies follow the examples of WeChat's push documentation
// (https://developers.weixin.qq.com/doc/service/guide/product/message/Receiving_standard_messages.html and
// the event, menu event, mass-send and publish pages); each refusal names its fault.
import {
  WXOA_PAYLOAD_MAX,
  wxoaEncryptOf,
  wxoaParseXml,
  wxoaReadPush,
  type WxoaReply,
  wxoaReplyXml,
  WxoaXmlError,
  type WxoaXmlFault,
} from '../../src/modules/platform/wxoa/core/wxoa-xml.js'

/** The fault `run` was refused with, null when it went through. */
function faultOf(run: () => unknown): WxoaXmlFault | null {
  try {
    run()
  } catch (err) {
    if (err instanceof WxoaXmlError) return err.fault
    throw err
  }
  return null
}

const HEAD =
  '<ToUserName><![CDATA[gh_0123456789ab]]></ToUserName><FromUserName><![CDATA[oFan0123456789]]></FromUserName><CreateTime>1714112445</CreateTime>'
const xml = (inner: string) => `<xml>${HEAD}${inner}</xml>`
const message = (kind: string, inner: string, msgId = '1234567890123456') =>
  xml(`<MsgType><![CDATA[${kind}]]></MsgType>${inner}<MsgId>${msgId}</MsgId>`)
const event = (name: string, inner = '') =>
  xml(`<MsgType><![CDATA[event]]></MsgType><Event><![CDATA[${name}]]></Event>${inner}`)
const read = (body: string) => wxoaReadPush(wxoaParseXml(body))

describe('parse', () => {
  it('a DOCTYPE or an ENTITY outside comments and CDATA is refused before parsing', () => {
    for (const body of [
      '<!DOCTYPE xml [<!ENTITY e "boom">]><xml><A>&e;</A></xml>',
      '<!DOCTYPE xml><xml><A>1</A></xml>',
      '<!doctype xml><xml><A>1</A></xml>',
      `<xml>${HEAD}<!ENTITY e SYSTEM "file:///etc/passwd"></xml>`,
      '<!-- <![CDATA[ --><!DOCTYPE x><!-- ]]> --><xml><A>1</A></xml>',
      '<![CDATA[ <!-- ]]><!DOCTYPE x><![CDATA[ --> ]]><xml><A>1</A></xml>',
      // an opener inside a processing instruction, an attribute value or any `<![` hides nothing
      xml('<?pi <!-- ?><!DOCTYPE x [<!ENTITY e "boom">]><!-- --><Content>&e;</Content>'),
      xml('<?pi a="?><!--"?><!DOCTYPE x [<!ENTITY e "boom">]><!-- --><Content>&e;</Content>'),
      `<xml a="<!--"><!DOCTYPE x [<!ENTITY e "boom">]><Content b="-->">&e;</Content>${HEAD}</xml>`,
      xml(`<![cdata[ <!-- ' ]]><!DOCTYPE x [<!ENTITY e "boom">]><!-- --><Content>&e;</Content>`),
      xml('<A b="<![CDATA[">1</A><!DOCTYPE x><B c="]]>">2</B>'),
      xml('<A b="><!--">1</A><!DOCTYPE x><B c="-->">2</B>'),
      xml('<A>1</A "><!DOCTYPE x>">'),
    ])
      expect(faultOf(() => wxoaParseXml(body))).toBe('doctype')
  })

  it('a body full of openers left open is scanned in linear time', () => {
    for (const body of [
      '<!--'.repeat(16384),
      '<![CDATA['.repeat(7282),
      `<xml a="${'<!--'.repeat(16000)}"><A>1</A></xml>`,
    ]) {
      const start = performance.now()
      faultOf(() => wxoaParseXml(body))
      expect(performance.now() - start).toBeLessThan(50)
    }
  })

  it('a DOCTYPE or an ENTITY inside a CDATA section or a comment is text', () => {
    const body = xml(
      '<MsgType><![CDATA[text]]></MsgType><Content><![CDATA[<!DOCTYPE html><!ENTITY e "x">]]></Content><MsgId>1</MsgId><!-- <!DOCTYPE x> --><Encrypt><![CDATA[abc=]]></Encrypt>',
    )
    expect(wxoaEncryptOf(wxoaParseXml(body))).toBe('abc=')
    expect(read(body).text).toBe('<!DOCTYPE html><!ENTITY e "x">')
  })

  it('entities stay as written', () => {
    expect(wxoaParseXml('<xml><A>a&amp;b&lt;c</A></xml>')).toEqual({ A: 'a&amp;b&lt;c' })
  })

  it('the root must be <xml>, alone', () => {
    for (const body of [
      '<foo><A>1</A></foo>',
      '<XML><A>1</A></XML>',
      '<?foo bar?><xml><A>1</A></xml>',
      '<xml></xml>',
      '<xml>text only</xml>',
    ])
      expect(faultOf(() => wxoaParseXml(body))).toBe('root')
    expect(wxoaParseXml('<?xml version="1.0" encoding="UTF-8"?>\n<xml><A>1</A></xml>')).toEqual({
      A: '1',
    })
  })

  it('a body that is not well-formed is refused', () => {
    for (const body of [
      '<xml><A>1</xml>',
      '<xml><A>1</A></xml><xml><A>2</A></xml>',
      'not xml',
      '',
      '<xml><__proto__>1</__proto__></xml>',
      '<![cdata[ <!DOCTYPE x> ]]><xml><A>1</A></xml>',
      '<xml><A><![CDATA[x</A><!DOCTYPE x></xml>',
    ])
      expect(faultOf(() => wxoaParseXml(body))).toBe('syntax')
  })

  it('tag values stay strings: a 64-bit MsgId, leading zeros, spaces inside CDATA', () => {
    const push = read(
      message('text', '<Content><![CDATA[ 007 ]]></Content>', '18446744073709551615'),
    )
    expect(push.msgId).toBe('18446744073709551615')
    expect(push.payload).toEqual({ Content: ' 007 ' })
    expect(push.text).toBe(' 007 ')
    expect(push.createTime).toBe(1714112445)
  })

  it('attributes are ignored', () => {
    expect(wxoaParseXml('<xml a="1"><A b="2">x</A></xml>')).toEqual({ A: 'x' })
  })
})

describe('Encrypt of an encrypted push', () => {
  it('the value, null when missing or empty, refused when repeated', () => {
    expect(wxoaEncryptOf(wxoaParseXml(xml('<Encrypt><![CDATA[abc=]]></Encrypt>')))).toBe('abc=')
    expect(wxoaEncryptOf(wxoaParseXml(xml('')))).toBeNull()
    expect(wxoaEncryptOf(wxoaParseXml(xml('<Encrypt></Encrypt>')))).toBeNull()
    expect(
      faultOf(() =>
        wxoaEncryptOf(wxoaParseXml(xml('<Encrypt>abc=</Encrypt><Encrypt>def=</Encrypt>'))),
      ),
    ).toBe('shape')
  })
})

describe('read: user messages', () => {
  it('each kind keeps its whitelisted fields only', () => {
    const cases: [string, string, Record<string, unknown>][] = [
      [
        'text',
        '<Content><![CDATA[this is a test]]></Content><MsgDataId>9</MsgDataId><Idx>1</Idx><Extra>x</Extra>',
        { Content: 'this is a test', MsgDataId: '9', Idx: '1' },
      ],
      [
        'image',
        '<PicUrl><![CDATA[https://mmbiz.qpic.cn/a.jpg]]></PicUrl><MediaId><![CDATA[m1]]></MediaId>',
        { PicUrl: 'https://mmbiz.qpic.cn/a.jpg', MediaId: 'm1' },
      ],
      [
        'voice',
        '<MediaId><![CDATA[m1]]></MediaId><Format><![CDATA[amr]]></Format><Recognition><![CDATA[hello]]></Recognition><MediaId16K><![CDATA[m2]]></MediaId16K>',
        { MediaId: 'm1', Format: 'amr', Recognition: 'hello', MediaId16K: 'm2' },
      ],
      [
        'video',
        '<MediaId><![CDATA[m1]]></MediaId><ThumbMediaId><![CDATA[t1]]></ThumbMediaId>',
        { MediaId: 'm1', ThumbMediaId: 't1' },
      ],
      [
        'shortvideo',
        '<MediaId><![CDATA[m1]]></MediaId><ThumbMediaId><![CDATA[t1]]></ThumbMediaId>',
        { MediaId: 'm1', ThumbMediaId: 't1' },
      ],
      [
        'location',
        '<Location_X>23.134521</Location_X><Location_Y>113.358803</Location_Y><Scale>20</Scale><Label><![CDATA[somewhere]]></Label>',
        { Location_X: '23.134521', Location_Y: '113.358803', Scale: '20', Label: 'somewhere' },
      ],
      [
        'link',
        '<Title><![CDATA[t]]></Title><Description><![CDATA[d]]></Description><Url><![CDATA[https://example.com]]></Url>',
        { Title: 't', Description: 'd', Url: 'https://example.com' },
      ],
    ]
    for (const [kind, inner, payload] of cases) {
      const push = read(message(kind, inner))
      expect(push).toMatchObject({
        known: true,
        msgKind: kind,
        msgId: '1234567890123456',
        msgID: null,
        eventKind: null,
        openId: 'oFan0123456789',
        toUser: 'gh_0123456789ab',
      })
      expect(push.payload).toEqual(payload)
    }
  })

  it('text is what keyword rules match: Content of text, Recognition of voice, nothing else', () => {
    expect(read(message('text', '<Content>hi</Content>')).text).toBe('hi')
    expect(read(message('voice', '<Recognition>said</Recognition>')).text).toBe('said')
    expect(read(message('voice', '<MediaId>m</MediaId>')).text).toBeNull()
    expect(read(message('link', '<Title>t</Title>')).text).toBeNull()
  })

  it('a user message without a numeric MsgId is refused', () => {
    expect(faultOf(() => read(xml('<MsgType>text</MsgType><Content>a</Content>')))).toBe('shape')
    expect(faultOf(() => read(message('text', '<Content>a</Content>', '12a')))).toBe('shape')
    expect(faultOf(() => read(message('text', '<Content>a</Content>', '1'.repeat(21))))).toBe(
      'shape',
    )
  })

  it('an image link on mmbiz is stored as https, any other host as it came', () => {
    const pic = (url: string) =>
      read(message('image', `<PicUrl><![CDATA[${url}]]></PicUrl>`)).payload.PicUrl
    expect(pic('http://mmbiz.qpic.cn/mmbiz_jpg/x/0')).toBe('https://mmbiz.qpic.cn/mmbiz_jpg/x/0')
    expect(pic('http://example.com/a.jpg')).toBe('http://example.com/a.jpg')
  })
})

describe('read: repeated tags and nesting', () => {
  it('a single-value field repeated or holding elements is refused', () => {
    for (const body of [
      message('text', '<Content>a</Content><Content>b</Content>'),
      message('text', '<Content><b>x</b></Content>'),
      message('image', '<PicUrl>a</PicUrl><PicUrl>b</PicUrl>'),
      xml('<MsgType>text</MsgType><MsgType>image</MsgType><Content>a</Content><MsgId>1</MsgId>'),
      event('CLICK', '<EventKey>k1</EventKey><EventKey>k2</EventKey>'),
      event(
        'scancode_push',
        '<ScanCodeInfo><ScanType>qrcode</ScanType><ScanType>x</ScanType></ScanCodeInfo>',
      ),
      event(
        'PUBLISHJOBFINISH',
        '<PublishEventInfo><publish_id>1</publish_id><publish_id>2</publish_id></PublishEventInfo>',
      ),
      // the common fields of a kind without its own structure are single values too
      event('user_info_modified', '<EventKey>a</EventKey><EventKey>b</EventKey>'),
      xml('<MsgType>event</MsgType><Event>x</Event><FromUserName>o2</FromUserName>'),
      xml('<MsgType>event</MsgType><Event>x</Event><ToUserName>gh2</ToUserName>'),
    ])
      expect(faultOf(() => read(body))).toBe('shape')
  })

  it('a push without the common fields is refused', () => {
    for (const body of [
      '<xml><MsgType>text</MsgType><Content>a</Content><MsgId>1</MsgId></xml>',
      xml('<Content>a</Content>'),
      `<xml><ToUserName>gh</ToUserName><FromUserName>o</FromUserName><CreateTime>soon</CreateTime><MsgType>event</MsgType></xml>`,
    ])
      expect(faultOf(() => read(body))).toBe('shape')
  })

  it('publish receipts: PublishEventInfo with its article list, or the failed indexes', () => {
    const ok = read(
      event(
        'PUBLISHJOBFINISH',
        '<PublishEventInfo><publish_id>2247503051</publish_id><publish_status>0</publish_status><article_id><![CDATA[b5O2OUs25HBxRceL7hfReg-U9QGeq9zQjiDvy\nWP4Hq4]]></article_id><article_detail><count>1</count><item><idx>1</idx><article_url><![CDATA[ARTICLE_URL]]></article_url></item></article_detail></PublishEventInfo>',
      ),
    )
    expect(ok.known).toBe(true)
    expect(ok.payload).toEqual({
      PublishEventInfo: {
        publish_id: '2247503051',
        publish_status: '0',
        article_id: 'b5O2OUs25HBxRceL7hfReg-U9QGeq9zQjiDvy\nWP4Hq4',
        article_detail: { count: '1', item: [{ idx: '1', article_url: 'ARTICLE_URL' }] },
      },
    })
    const failed = read(
      event(
        'PUBLISHJOBFINISH',
        '<PublishEventInfo><publish_id>2247503051</publish_id><publish_status>2</publish_status><fail_idx>1</fail_idx><fail_idx>2</fail_idx></PublishEventInfo>',
      ),
    )
    expect(failed.payload).toEqual({
      PublishEventInfo: { publish_id: '2247503051', publish_status: '2', fail_idx: ['1', '2'] },
    })
  })

  it('elements outside the whitelist are dropped inside nested groups too', () => {
    expect(
      read(
        event(
          'scancode_push',
          '<ScanCodeInfo><ScanType>qrcode</ScanType><Extra>x</Extra></ScanCodeInfo>',
        ),
      ).payload,
    ).toEqual({ ScanCodeInfo: { ScanType: 'qrcode' } })
    expect(
      read(
        event(
          'PUBLISHJOBFINISH',
          '<PublishEventInfo><publish_id>1</publish_id><Extra>x</Extra><article_detail><count>1</count><Extra>x</Extra><item><idx>1</idx><Extra>x</Extra></item></article_detail></PublishEventInfo>',
        ),
      ).payload,
    ).toEqual({
      PublishEventInfo: { publish_id: '1', article_detail: { count: '1', item: [{ idx: '1' }] } },
    })
  })

  it('mass-send receipts: counts, the copyright check and article urls', () => {
    const item = (n: number) =>
      `<item><ArticleIdx>${n}</ArticleIdx><UserDeclareState>0</UserDeclareState><AuditState>2</AuditState><OriginalArticleUrl><![CDATA[Url_${n}]]></OriginalArticleUrl><OriginalArticleType>1</OriginalArticleType><CanReprint>1</CanReprint><NeedReplaceContent>1</NeedReplaceContent><NeedShowReprintSource>1</NeedShowReprintSource></item>`
    const push = wxoaReadPush(
      wxoaParseXml(
        `<xml><ToUserName><![CDATA[gh_4d00ed8d6399]]></ToUserName><FromUserName><![CDATA[mphelper]]></FromUserName><CreateTime>1481013459</CreateTime><MsgType><![CDATA[event]]></MsgType><Event><![CDATA[MASSSENDJOBFINISH]]></Event><MsgID>1000001625</MsgID><Status><![CDATA[err(30003)]]></Status><TotalCount>0</TotalCount><FilterCount>0</FilterCount><SentCount>0</SentCount><ErrorCount>0</ErrorCount><CopyrightCheckResult><Count>2</Count><ResultList>${item(1)}${item(2)}</ResultList><CheckState>2</CheckState></CopyrightCheckResult><ArticleUrlResult><Count>1</Count><ResultList><item><ArticleIdx>1</ArticleIdx><ArticleUrl><![CDATA[Url]]></ArticleUrl></item></ResultList></ArticleUrlResult></xml>`,
      ),
    )
    expect(push).toMatchObject({
      known: true,
      openId: 'mphelper',
      msgID: '1000001625',
      msgId: null,
    })
    const payload = push.payload as {
      Status: string
      CopyrightCheckResult: { ResultList: { item: { OriginalArticleUrl: string }[] } }
      ArticleUrlResult: { ResultList: { item: { ArticleUrl: string }[] } }
    }
    expect(payload.Status).toBe('err(30003)')
    expect(payload.CopyrightCheckResult.ResultList.item.map((i) => i.OriginalArticleUrl)).toEqual([
      'Url_1',
      'Url_2',
    ])
    expect(payload.ArticleUrlResult.ResultList.item).toEqual([
      { ArticleIdx: '1', ArticleUrl: 'Url' },
    ])
  })

  it('menu events: scan code, pictures, location, view', () => {
    expect(
      read(
        event(
          'scancode_waitmsg',
          '<EventKey><![CDATA[6]]></EventKey><ScanCodeInfo><ScanType><![CDATA[qrcode]]></ScanType><ScanResult><![CDATA[2]]></ScanResult></ScanCodeInfo>',
        ),
      ),
    ).toMatchObject({
      eventKey: '6',
      payload: { ScanCodeInfo: { ScanType: 'qrcode', ScanResult: '2' } },
    })
    expect(
      read(
        event(
          'pic_sysphoto',
          '<EventKey>6</EventKey><SendPicsInfo><Count>1</Count><PicList><item><PicMd5Sum><![CDATA[1b5f]]></PicMd5Sum></item></PicList></SendPicsInfo>',
        ),
      ).payload,
    ).toEqual({ SendPicsInfo: { Count: '1', PicList: { item: [{ PicMd5Sum: '1b5f' }] } } })
    expect(
      read(
        event(
          'location_select',
          '<EventKey>6</EventKey><SendLocationInfo><Location_X><![CDATA[23]]></Location_X><Location_Y><![CDATA[113]]></Location_Y><Scale><![CDATA[15]]></Scale><Label><![CDATA[ a road 106]]></Label><Poiname><![CDATA[]]></Poiname></SendLocationInfo>',
        ),
      ).payload,
    ).toEqual({
      SendLocationInfo: {
        Location_X: '23',
        Location_Y: '113',
        Scale: '15',
        Label: ' a road 106',
        Poiname: '',
      },
    })
    expect(
      read(event('VIEW', '<EventKey><![CDATA[https://www.qq.com]]></EventKey><MenuId>7</MenuId>')),
    ).toMatchObject({ eventKind: 'VIEW', eventKey: 'https://www.qq.com', payload: { MenuId: '7' } })
  })

  it('subscribe with a QR scene, SCAN, template receipt', () => {
    expect(
      read(
        event(
          'subscribe',
          '<EventKey><![CDATA[qrscene_spring]]></EventKey><Ticket><![CDATA[T]]></Ticket>',
        ),
      ),
    ).toMatchObject({
      eventKind: 'subscribe',
      eventKey: 'qrscene_spring',
      payload: { Ticket: 'T' },
    })
    expect(read(event('SCAN', '<EventKey>spring</EventKey><Ticket>T</Ticket>'))).toMatchObject({
      eventKind: 'SCAN',
      eventKey: 'spring',
    })
    expect(
      read(
        event(
          'TEMPLATESENDJOBFINISH',
          '<MsgID>200163836</MsgID><Status><![CDATA[success]]></Status>',
        ),
      ),
    ).toMatchObject({ known: true, msgID: '200163836', payload: { Status: 'success' } })
  })

  it('subscribe-notice events: List items inside their outer element, a top-level List dropped', () => {
    const list = (fields: string) => `<List>${fields}</List>`
    expect(
      read(
        event(
          'subscribe_msg_popup_event',
          `<SubscribeMsgPopupEvent>${list('<TemplateId>a</TemplateId><SubscribeStatusString>accept</SubscribeStatusString><PopupScene>2</PopupScene><Extra>x</Extra>')}${list('<TemplateId>b</TemplateId><SubscribeStatusString>reject</SubscribeStatusString><PopupScene>2</PopupScene>')}</SubscribeMsgPopupEvent><List><TemplateId>top</TemplateId></List>`,
        ),
      ).payload,
    ).toEqual({
      SubscribeMsgPopupEvent: {
        List: [
          { TemplateId: 'a', SubscribeStatusString: 'accept', PopupScene: '2' },
          { TemplateId: 'b', SubscribeStatusString: 'reject', PopupScene: '2' },
        ],
      },
    })
    expect(
      read(
        event(
          'subscribe_msg_change_event',
          `<SubscribeMsgChangeEvent>${list('<TemplateId>a</TemplateId><SubscribeStatusString>reject</SubscribeStatusString><PopupScene>2</PopupScene>')}</SubscribeMsgChangeEvent>`,
        ),
      ).payload,
    ).toEqual({
      SubscribeMsgChangeEvent: { List: [{ TemplateId: 'a', SubscribeStatusString: 'reject' }] },
    })
    expect(
      read(
        event(
          'subscribe_msg_sent_event',
          `<SubscribeMsgSentEvent>${list('<TemplateId>a</TemplateId><MsgID>1700827132819554304</MsgID><ErrorCode>0</ErrorCode><ErrorStatus>success</ErrorStatus>')}</SubscribeMsgSentEvent>`,
        ),
      ).payload,
    ).toEqual({
      SubscribeMsgSentEvent: {
        List: [
          { TemplateId: 'a', MsgID: '1700827132819554304', ErrorCode: '0', ErrorStatus: 'success' },
        ],
      },
    })
  })

  it('a list cut to 20 items; an empty group or list reads as empty', () => {
    const pics = '<item><PicMd5Sum>p</PicMd5Sum></item>'.repeat(25)
    const many = read(
      event(
        'pic_weixin',
        `<SendPicsInfo><Count>25</Count><PicList>${pics}</PicList></SendPicsInfo>`,
      ),
    ).payload as { SendPicsInfo: { PicList: { item: unknown[] } } }
    expect(many.SendPicsInfo.PicList.item).toHaveLength(20)
    expect(read(event('scancode_push', '<ScanCodeInfo></ScanCodeInfo>')).payload).toEqual({
      ScanCodeInfo: {},
    })
    expect(
      read(event('pic_weixin', '<SendPicsInfo><Count>0</Count><PicList></PicList></SendPicsInfo>'))
        .payload,
    ).toEqual({ SendPicsInfo: { Count: '0', PicList: {} } })
  })
})

describe('read: kinds without a structure', () => {
  it('an unknown event with nested elements: the common fields only, an empty payload', () => {
    const push = read(
      event(
        'user_info_modified',
        '<UserID><![CDATA[o1]]></UserID><Nested><A>1</A><A>2</A><B><C>x</C></B></Nested><MsgID>77</MsgID>',
      ),
    )
    expect(push).toMatchObject({
      known: false,
      msgKind: 'event',
      eventKind: 'user_info_modified',
      msgID: '77',
      payload: {},
      text: null,
    })
  })

  it('an unknown message kind keeps its MsgId', () => {
    const push = read(message('miniprogrampage', '<Title>t</Title>', '18446744073709551615'))
    expect(push).toMatchObject({
      known: false,
      msgKind: 'miniprogrampage',
      msgId: '18446744073709551615',
      payload: {},
    })
  })

  it('an Event named like an Object property is an unknown kind, not a crash', () => {
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty'])
      expect(read(event(name)).known).toBe(false)
    expect(read(xml('<MsgType>constructor</MsgType><MsgId>1</MsgId>')).known).toBe(false)
  })

  it('an event without Event is unknown', () => {
    expect(read(xml('<MsgType>event</MsgType>'))).toMatchObject({ known: false, eventKind: null })
  })
})

describe('read: column widths', () => {
  it('common fields are cut to their columns, by characters, never inside one', () => {
    const smile = '\u{1f600}'
    const push = read(
      xml(
        `<MsgType>${'k'.repeat(30)}</MsgType><Event>${smile.repeat(60)}</Event><EventKey>${'u'.repeat(1500)}</EventKey><MsgId>${'9'.repeat(30)}</MsgId><MsgID>${'8'.repeat(30)}</MsgID>`,
      ).replace('oFan0123456789', 'o'.repeat(100)),
    )
    expect(push.msgKind).toBe('k'.repeat(24))
    expect(push.eventKind).toBe(smile.repeat(48))
    expect(push.eventKey).toHaveLength(1024)
    expect(push.openId).toBe('o'.repeat(64))
    expect(push.msgId).toBe('9'.repeat(24))
    expect(push.msgID).toBe('8'.repeat(24))
  })
})

describe('read: payload size', () => {
  const jsonBytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v))

  it('a payload within the limit is kept whole, not flagged', () => {
    const content = 'x'.repeat(WXOA_PAYLOAD_MAX - 100)
    const push = read(message('text', `<Content><![CDATA[${content}]]></Content>`))
    expect(push.payload).toEqual({ Content: content })
  })

  it('a text of about 20 KiB is cut to fit, flagged, and kept whole for matching', () => {
    const content = `${'你'.repeat(3000)}${'\u{1f600}'.repeat(1000)}"quoted"${'a'.repeat(4000)}`
    expect(Buffer.byteLength(content)).toBeGreaterThan(16 * 1024)
    const push = read(message('text', `<Content><![CDATA[${content}]]></Content>`))
    expect(push.payload.truncated).toBe(true)
    expect(jsonBytes(push.payload)).toBeLessThanOrEqual(WXOA_PAYLOAD_MAX)
    expect(jsonBytes(push.payload)).toBeGreaterThan(WXOA_PAYLOAD_MAX - 8)
    const kept = push.payload.Content as string
    expect(content.startsWith(kept)).toBe(true)
    // never cut inside a surrogate pair: UTF-8 round trip unchanged
    expect(Buffer.from(kept).toString()).toBe(kept)
    expect(push.text).toBe(content)
  })

  it('the longest texts are cut first, the short ones kept', () => {
    const push = read(
      message(
        'link',
        `<Title>${'t'.repeat(12_000)}</Title><Description>${'d'.repeat(10_000)}</Description><Url>https://example.com/</Url>`,
      ),
    )
    const payload = push.payload as { Title: string; Description: string; Url: string }
    expect(payload.Url).toBe('https://example.com/')
    expect(jsonBytes(payload)).toBeLessThanOrEqual(WXOA_PAYLOAD_MAX)
    expect(payload.Title.length + payload.Description.length).toBeGreaterThan(16_000)
  })

  it('texts that grow when escaped still end within the limit', () => {
    const content = '\u0001'.repeat(20_000)
    const push = read(message('text', `<Content><![CDATA[${content}]]></Content>`))
    expect(jsonBytes(push.payload)).toBeLessThanOrEqual(WXOA_PAYLOAD_MAX)
    expect(push.payload.truncated).toBe(true)
  })
})

describe('passive reply', () => {
  const push = { openId: 'oFan0123456789', toUser: 'gh_0123456789ab' }
  const now = 1_714_112_445_000

  it('every kind as WeChat documents it, to the sender from the account', () => {
    const cases: [WxoaReply, Record<string, unknown>][] = [
      [{ kind: 'text', content: 'hello' }, { Content: 'hello' }],
      [{ kind: 'image', mediaId: 'm1' }, { Image: { MediaId: 'm1' } }],
      [{ kind: 'voice', mediaId: 'm1' }, { Voice: { MediaId: 'm1' } }],
      [{ kind: 'video', mediaId: 'm1' }, { Video: { MediaId: 'm1' } }],
      [
        { kind: 'video', mediaId: 'm1', title: 't', description: 'd' },
        { Video: { MediaId: 'm1', Title: 't', Description: 'd' } },
      ],
      [
        {
          kind: 'music',
          title: 't',
          description: 'd',
          musicUrl: 'https://a.example/m.mp3',
          hqMusicUrl: 'https://a.example/hq.mp3',
          thumbMediaId: 'th',
        },
        {
          Music: {
            Title: 't',
            Description: 'd',
            MusicUrl: 'https://a.example/m.mp3',
            HQMusicUrl: 'https://a.example/hq.mp3',
            ThumbMediaId: 'th',
          },
        },
      ],
      [
        {
          kind: 'news',
          title: 't',
          description: 'd',
          url: 'https://a.example/?a=1&b=2',
          picUrl: 'https://mmbiz.qpic.cn/p',
        },
        {
          ArticleCount: '1',
          Articles: {
            item: {
              Title: 't',
              Description: 'd',
              PicUrl: 'https://mmbiz.qpic.cn/p',
              Url: 'https://a.example/?a=1&b=2',
            },
          },
        },
      ],
    ]
    for (const [reply, fields] of cases)
      expect(wxoaParseXml(wxoaReplyXml(push, reply, now)!)).toEqual({
        ToUserName: 'oFan0123456789',
        FromUserName: 'gh_0123456789ab',
        CreateTime: '1714112445',
        MsgType: reply.kind,
        ...fields,
      })
  })

  it('a ]]> in a text is split over two CDATA sections', () => {
    const content = 'a]]>b]]>]]><c>&amp;'
    const out = wxoaReplyXml(push, { kind: 'text', content }, now)!
    expect(out).toContain('<Content><![CDATA[a]]]]><![CDATA[>b]]]]><![CDATA[>]]]]><![CDATA[>')
    expect(wxoaParseXml(out).Content).toBe(content)
  })

  it('a character XML forbids anywhere in it: no reply at all', () => {
    for (const reply of [
      { kind: 'text', content: 'bell\u0007' },
      { kind: 'text', content: 'lone \ud800 surrogate' },
      { kind: 'text', content: '￾' },
      {
        kind: 'news',
        title: 't\u000b',
        description: 'd',
        url: 'https://a.example',
        picUrl: 'https://a.example/p',
      },
      { kind: 'video', mediaId: 'm', description: '\u0000' },
    ] as WxoaReply[])
      expect(wxoaReplyXml(push, reply, now)).toBeNull()
    expect(
      wxoaReplyXml({ ...push, openId: 'o\u0001' }, { kind: 'text', content: 'ok' }, now),
    ).toBeNull()
    // tab, newline, carriage return and a paired surrogate are fine
    expect(
      wxoaReplyXml(push, { kind: 'text', content: 'a\tb\nc\rd \u{1f600}' }, now),
    ).not.toBeNull()
  })
})
