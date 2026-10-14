import React from 'react'

const WEEKDAYS = '日一二三四五六'

export function greetingFor(date: Date): string {
  const hour = date.getHours()
  const greeting = hour < 5 ? '夜深了' : hour < 11 ? '早上好' : hour < 13 ? '中午好' : hour < 18 ? '下午好' : '晚上好'
  return `${greeting} · ${date.getMonth() + 1}月${date.getDate()}日 星期${WEEKDAYS[date.getDay()]}`
}

export function HomeGreeting(): React.JSX.Element {
  const [text] = React.useState(() => greetingFor(new Date()))
  return <p className="home-greeting"><i aria-hidden="true" />{text}</p>
}
