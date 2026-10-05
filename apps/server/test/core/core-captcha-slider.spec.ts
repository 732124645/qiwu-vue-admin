import { sliderChallenge } from '../../src/core/captcha/captcha-slider.js'

it('keeps 50 slider pieces in bounds and varies image and position', async () => {
  const positions = new Set<string>()
  const images = new Set<string>()
  for (let i = 0; i < 50; i++) {
    const piece = await sliderChallenge()
    expect(piece.answer.x).toBeGreaterThanOrEqual(piece.thumbWidth + 10)
    expect(piece.answer.x + piece.thumbWidth).toBeLessThanOrEqual(300 - 10)
    expect(piece.answer.y).toBeGreaterThanOrEqual(10)
    expect(piece.answer.y + piece.thumbHeight).toBeLessThanOrEqual(220 - 10)
    positions.add(`${piece.answer.x},${piece.answer.y}`)
    images.add(piece.image)
  }
  expect(positions.size).toBeGreaterThan(1)
  expect(images.size).toBeGreaterThan(1)
}, 20_000)
