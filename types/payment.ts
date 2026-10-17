export type PaymentGateway = 'doku' | 'midtrans'

export interface PaymentChargeResult {
  orderId : string
  transactionId : string | null
  transactionStatus : string
  qrCodeUrl : string | null
  deeplinkUrl : string | null
  grossAmount : number
  paymentType : string
  gateway : PaymentGateway
  expiryTime? : string | null
}

export type PaymentChargeState = PaymentChargeResult & {
  boothName? : string
}
