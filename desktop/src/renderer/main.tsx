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
        token: {
          colorPrimary: '#5b58d6',
          borderRadius: 10,
          fontFamily: 'Inter, "Microsoft YaHei UI", "PingFang SC", sans-serif',
          colorBgBase: '#f7f2e8',
          colorBgContainer: '#fbf8f2',
          colorBgLayout: '#f7f2e8',
          colorBorder: '#dcd4c7',
          colorText: '#27231e'
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
