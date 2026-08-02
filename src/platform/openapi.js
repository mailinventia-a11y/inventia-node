export const phase5OpenApi = {
  openapi: '3.1.0',
  info: {
    title: 'Inventia Enterprise Core Trade API',
    version: '6.0.0',
    description: 'Tenant-isolated products, inventory, trade, GST invoices, unified payments, barcodes, labels, dashboard, settings namespaces, and feature-flag APIs.'
  },
  servers: [{ url: '/api/v1' }],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      idempotencyKey: { type: 'apiKey', in: 'header', name: 'Idempotency-Key' }
    },
    schemas: {
      Error: {
        type: 'object',
        properties: {
          error: {
            type: 'object',
            required: ['code', 'message', 'request_id'],
            properties: {
              code: { type: 'string' },
              message: { type: 'string' },
              request_id: { type: 'string' }
            }
          }
        }
      },
      PaymentAllocationInput: {
        type: 'object',
        required: ['method', 'amount'],
        properties: {
          method: { type: 'string', examples: ['CASH', 'UPI', 'CHEQUE', 'CUSTOMER_CREDIT'] },
          amount: { type: 'number', exclusiveMinimum: 0 },
          reference: { type: 'string' },
          provider_transaction_id: { type: 'string' }
        }
      },
      CheckoutInput: {
        type: 'object',
        required: ['warehouse_id', 'items'],
        properties: {
          customer_id: { type: ['integer', 'null'] },
          warehouse_id: { type: 'integer' },
          items: { type: 'array', minItems: 1, items: { type: 'object' } },
          discount: { type: 'number', minimum: 0 },
          payments: { type: 'array', items: { $ref: '#/components/schemas/PaymentAllocationInput' } },
          payment_method: { type: 'string', description: 'Temporary single-payment compatibility field.' },
          allow_partial_payment: { type: 'boolean' },
          due_date: { type: 'string', format: 'date' },
          invoice_details: { type: 'object' }
        }
      },
      SettingsNamespace: {
        type: 'object',
        required: ['namespace', 'settings'],
        properties: {
          namespace: {
            type: 'string',
            enum: ['organization', 'documents', 'pos', 'inventory', 'notifications', 'communications', 'ai']
          },
          settings: { type: 'object', additionalProperties: true },
          updated_by: { type: ['string', 'null'] },
          updated_at: { type: ['string', 'null'], format: 'date-time' }
        }
      },
      FeatureFlag: {
        type: 'object',
        required: ['key', 'enabled', 'configuration'],
        properties: {
          key: { type: 'string' },
          enabled: { type: 'boolean' },
          configuration: { type: 'object', additionalProperties: true },
          updated_by: { type: ['string', 'null'] },
          updated_at: { type: ['string', 'null'], format: 'date-time' }
        }
      }
    }
  },
  security: [{ bearerAuth: [] }],
  paths: {
    '/auth/login': { post: { security: [], summary: 'Authenticate in an organization', responses: { 200: { description: 'Authenticated' } } } },
    '/auth/refresh': { post: { security: [], summary: 'Rotate a refresh session', responses: { 200: { description: 'Token pair' } } } },
    '/auth/logout': { post: { summary: 'Revoke a refresh session', responses: { 204: { description: 'Revoked' } } } },
    '/organizations': { get: { summary: 'List available organizations', responses: { 200: { description: 'Organizations' } } } },
    '/products': {
      get: { summary: 'List products', responses: { 200: { description: 'Products' } } },
      post: { summary: 'Create a product', responses: { 201: { description: 'Created' } } }
    },
    '/inventory/balances': { get: { summary: 'Inventory balances', responses: { 200: { description: 'Balances' } } } },
    '/inventory/movements': { get: { summary: 'Immutable stock ledger', responses: { 200: { description: 'Movements' } } } },
    '/barcodes/overview': { get: { summary: 'Barcode operations KPIs and recent activity', responses: { 200: { description: 'Barcode overview' } } } },
    '/barcodes/products': { get: { summary: 'Product barcode assignments joined to live inventory', responses: { 200: { description: 'Barcode products' } } } },
    '/barcodes/generate': { post: { summary: 'Assign collision-safe barcodes to missing products', responses: { 201: { description: 'Assignments created' } } } },
    '/barcodes/assign': { post: { summary: 'Validate and manually assign a persistent barcode', responses: { 201: { description: 'Assignment created' }, 409: { description: 'Duplicate barcode' } } } },
    '/barcodes/{id}/regenerate': { post: { summary: 'Archive and explicitly regenerate an audited barcode identity', responses: { 200: { description: 'Assignment regenerated' } } } },
    '/barcodes/{id}/render': { get: { summary: 'Render an authenticated barcode as PNG or SVG', responses: { 200: { description: 'Barcode image' } } } },
    '/barcode-templates': {
      get: { summary: 'List label templates and physical paper layouts', responses: { 200: { description: 'Templates and layouts' } } },
      post: { summary: 'Create a structured label template', responses: { 201: { description: 'Template created' } } }
    },
    '/barcode-print-jobs': {
      get: { summary: 'List persisted label output jobs', responses: { 200: { description: 'Print jobs' } } },
      post: { summary: 'Create physical PDF or PNG ZIP label output', responses: { 201: { description: 'Print job created' } } }
    },
    '/barcode-scans/resolve': { post: { summary: 'Resolve and audit an exact product or variant barcode scan', responses: { 200: { description: 'Scan resolved' }, 404: { description: 'Unknown barcode recorded' } } } },
    '/barcode-analytics': { get: { summary: 'Barcode, scan, template, and print analytics', responses: { 200: { description: 'Barcode analytics' } } } },
    '/barcode-recommendations': { get: { summary: 'Grounded barcode operations recommendations', responses: { 200: { description: 'Recommendations' } } } },
    '/barcode-settings': {
      get: { summary: 'Read organization barcode rules', responses: { 200: { description: 'Barcode settings' } } },
      put: { summary: 'Update organization barcode and scanner rules', responses: { 200: { description: 'Settings updated' } } }
    },
    '/trade/{documentType}': {
      get: { summary: 'List trade documents', responses: { 200: { description: 'Documents' } } },
      post: { summary: 'Create trade document', responses: { 201: { description: 'Created' } } }
    },
    '/trade/{documentType}/{id}/convert': { post: { summary: 'Create an auditable linked document without mutating the source', responses: { 201: { description: 'Linked document created' }, 409: { description: 'Invalid or duplicate conversion' } } } },
    '/document-links': { get: { summary: 'List the conversion and fiscal chain for an entity', responses: { 200: { description: 'Document links' } } } },
    '/document-templates': {
      get: { summary: 'List organization document templates', responses: { 200: { description: 'Templates' } } },
      post: { summary: 'Create an A4 or thermal document template', responses: { 201: { description: 'Template created' } } }
    },
    '/document-templates/{id}': { put: { summary: 'Update a document template', responses: { 200: { description: 'Template updated' } } } },
    '/fiscal-adjustments/{adjustmentType}': {
      get: { summary: 'List credit or debit notes', responses: { 200: { description: 'Fiscal adjustments' } } },
      post: { summary: 'Create an immutable-source fiscal adjustment draft', responses: { 201: { description: 'Draft created' } } }
    },
    '/fiscal-adjustments/{adjustmentType}/{id}': { get: { summary: 'Get a fiscal adjustment with lines, chain, and timeline', responses: { 200: { description: 'Fiscal adjustment' } } } },
    '/fiscal-adjustments/{adjustmentType}/{id}/issue': { post: { summary: 'Issue a fiscal adjustment and post its ledger and optional stock effect', responses: { 200: { description: 'Adjustment issued' } } } },
    '/fiscal-adjustments/{adjustmentType}/{id}/cancel': { post: { summary: 'Cancel an unissued fiscal adjustment draft', responses: { 200: { description: 'Draft cancelled' }, 409: { description: 'Issued note is immutable' } } } },
    '/dashboard/summary': { get: { summary: 'Organization dashboard summary', responses: { 200: { description: 'Summary' } } } },
    '/pos/checkout': {
      post: {
        summary: 'Atomically complete a POS sale, GST invoice, stock issue, payments, and ledger entries',
        security: [{ bearerAuth: [], idempotencyKey: [] }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/CheckoutInput' } } }
        },
        responses: {
          201: { description: 'Commercial transaction committed; PDF status is returned independently.' },
          409: { description: 'Stock, payment, credit, or idempotency conflict.' },
          422: { description: 'Validation failed.' }
        }
      }
    },
    '/invoices': { get: { summary: 'List and filter GST invoices', responses: { 200: { description: 'Invoices' } } } },
    '/invoices/{id}': { get: { summary: 'Get immutable invoice snapshot and payment history', responses: { 200: { description: 'Invoice detail' } } } },
    '/invoices/{id}/pdf': { get: { summary: 'Download an authenticated tenant-scoped invoice PDF', responses: { 200: { description: 'PDF document' }, 409: { description: 'PDF not ready' } } } },
    '/invoices/{id}/pdf/retry': { post: { summary: 'Generate a new immutable PDF version', responses: { 200: { description: 'Retry result' } } } },
    '/invoices/{id}/payments': { post: { summary: 'Collect one or more payments against an outstanding invoice', responses: { 201: { description: 'Collection recorded' } } } },
    '/payment-allocations/{id}/confirm': { post: { summary: 'Confirm an authorized pending manual allocation', responses: { 200: { description: 'Allocation confirmed' } } } },
    '/payment-allocations/{id}/refunds': { post: { summary: 'Refund a successful manual allocation', responses: { 201: { description: 'Refund recorded' } } } },
    '/settings/payment-methods': {
      get: { summary: 'List enabled payment methods and policies', responses: { 200: { description: 'Payment methods' } } },
      put: { summary: 'Configure organization payment methods', responses: { 200: { description: 'Updated methods' } } }
    },
    '/settings': {
      get: {
        summary: 'List all tenant settings namespaces with safe defaults',
        responses: { 200: { description: 'Settings namespaces' } }
      }
    },
    '/settings/{namespace}': {
      get: {
        summary: 'Read one tenant settings namespace',
        parameters: [{
          name: 'namespace',
          in: 'path',
          required: true,
          schema: {
            type: 'string',
            enum: ['organization', 'documents', 'pos', 'inventory', 'notifications', 'communications', 'ai']
          }
        }],
        responses: { 200: { description: 'Settings namespace' }, 404: { description: 'Unknown namespace' } }
      },
      put: {
        summary: 'Validate and update one tenant settings namespace',
        security: [{ bearerAuth: [], idempotencyKey: [] }],
        parameters: [{
          name: 'namespace',
          in: 'path',
          required: true,
          schema: {
            type: 'string',
            enum: ['organization', 'documents', 'pos', 'inventory', 'notifications', 'communications', 'ai']
          }
        }],
        responses: {
          200: { description: 'Settings updated' },
          400: { description: 'Idempotency key required' },
          403: { description: 'Permission denied' },
          422: { description: 'Invalid settings payload' }
        }
      }
    },
    '/feature-flags': {
      get: {
        summary: 'List organization feature flags used for controlled rollout',
        responses: { 200: { description: 'Feature flags' } }
      }
    },
    '/feature-flags/{key}': {
      put: {
        summary: 'Update an approved organization feature flag',
        security: [{ bearerAuth: [], idempotencyKey: [] }],
        responses: {
          200: { description: 'Feature flag updated' },
          404: { description: 'Unknown feature flag' }
        }
      }
    },
    '/payments/razorpay/orders': { post: { summary: 'Create a Razorpay order', responses: { 201: { description: 'Order created' }, 503: { description: 'Integration not configured' } } } },
    '/webhooks/razorpay': { post: { security: [], summary: 'Receive a signed Razorpay webhook', responses: { 202: { description: 'Accepted' } } } }
  }
};
