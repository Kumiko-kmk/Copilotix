import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ConfigProvider, theme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import App from './App'
import { currentTheme, mixHex, onThemeChange, restoreTheme, rgbChannels } from './theme'
import './styles.css'

// Before the first render, so the stored theme is the first thing painted.
restoreTheme()

function Root(): React.JSX.Element {
  const [active, setActive] = React.useState(() => currentTheme())
  React.useEffect(() => onThemeChange(setActive), [])
  const { colors } = active
  const shadow = active.dark ? '0, 0, 0' : rgbChannels(colors.ink)
  const rule = rgbChannels(colors.ink)
  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: active.dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
        // Archive language (文库): square corners, flat surfaces, ink primary actions that turn to the accent on hover.
        token: {
          colorPrimary: colors.primary,
          borderRadius: 2,
          borderRadiusLG: 3,
          borderRadiusSM: 2,
          fontFamily: 'Inter, "Microsoft YaHei UI", "PingFang SC", sans-serif',
          colorBgBase: colors.surface,
          colorBgContainer: mixHex(colors.surface, colors.sheet, 0.5),
          colorBgLayout: colors.surface,
          colorBgElevated: colors.sheet,
          colorBorder: colors.border,
          colorText: colors.text,
          boxShadow: `0 18px 40px -24px rgba(${shadow}, .45)`,
          boxShadowSecondary: `0 14px 32px -18px rgba(${shadow}, .4)`
        },
        components: {
          Button: {
            colorPrimary: colors.ink,
            colorPrimaryHover: colors.primary,
            colorPrimaryActive: mixHex(colors.primary, active.dark ? '#ffffff' : '#000000', 0.2),
            primaryColor: colors.onInk,
            primaryShadow: 'none',
            defaultShadow: 'none',
            dangerShadow: 'none',
            fontWeight: 600,
            // Disabled buttons stay flat on the paper instead of turning into grey blocks.
            colorBgContainerDisabled: 'transparent',
            borderColorDisabled: `rgba(${rule}, .18)`
          },
          Modal: { borderRadiusLG: 3 },
          Tag: { borderRadiusSM: 2 }
        }
      }}
    >
      <App />
    </ConfigProvider>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient({
    defaultOptions: {
      queries: { staleTime: 5_000, refetchOnWindowFocus: false }
    }
  })}>
    <React.StrictMode>
      <Root />
    </React.StrictMode>
  </QueryClientProvider>
)
