import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ConfigProvider, theme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import App from './App'
import './styles.css'

function Root(): React.JSX.Element {
  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: theme.defaultAlgorithm,
        // Archive language (文库): square corners, flat surfaces, ink primary actions that turn to the accent on hover.
        token: {
          colorPrimary: '#5b58d6',
          borderRadius: 2,
          borderRadiusLG: 3,
          borderRadiusSM: 2,
          fontFamily: 'Inter, "Microsoft YaHei UI", "PingFang SC", sans-serif',
          colorBgBase: '#f7f2e8',
          colorBgContainer: '#fbf8f2',
          colorBgLayout: '#f7f2e8',
          colorBorder: '#d6ccbd',
          colorText: '#27231e',
          boxShadow: '0 18px 40px -24px rgba(47, 42, 36, .45)',
          boxShadowSecondary: '0 14px 32px -18px rgba(47, 42, 36, .4)'
        },
        components: {
          Button: {
            colorPrimary: '#2f2a24',
            colorPrimaryHover: '#5b58d6',
            colorPrimaryActive: '#4743b8',
            primaryShadow: 'none',
            defaultShadow: 'none',
            dangerShadow: 'none',
            fontWeight: 600,
            // Disabled buttons stay flat on the paper instead of turning into grey blocks.
            colorBgContainerDisabled: 'transparent',
            borderColorDisabled: 'rgba(47, 42, 36, .18)'
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
