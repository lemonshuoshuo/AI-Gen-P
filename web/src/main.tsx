import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from 'react-router'
import { Toaster } from 'sonner'
import { OutboxSync } from '@/components/OutboxSync'
import { ConfirmHost } from '@/components/ui'
import { queryClient } from '@/lib/queryClient'
import { router } from '@/router'
import { useAuth } from '@/stores/auth'
import './index.css'

useAuth.getState().refreshMe()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster position="top-center" richColors closeButton />
      <ConfirmHost />
      <OutboxSync />
    </QueryClientProvider>
  </StrictMode>,
)
