'use client';
import { useState, useEffect, useMemo } from 'react';
import { Modal } from '../ui/modal';
import { Button, IconButton } from '../ui/button';
import { Alert } from '../ui/alert';
import { toast } from 'sonner';
import { applyMigrations, useUserData } from '@/context/userData';
import { useStatus } from '@/context/status';
import {
  SearchIcon,
  CheckIcon,
  AlertTriangleIcon,
  Trash2Icon,
} from 'lucide-react';
import { TextInput } from '../ui/text-input';
import { Textarea } from '../ui/textarea';
import * as constants from '../../../../core/src/utils/constants';
import { StatusResponse, Template } from '@aiostreams/core';
import MarkdownLite from './markdown-lite';
import { BiImport } from 'react-icons/bi';
import {
  useConfirmationDialog,
  ConfirmationDialog,
} from './confirmation-dialog';
import { PasswordInput } from '../ui/password-input';
import React from 'react';
import { z, ZodError } from 'zod';

const formatZodError = (error: ZodError) => {
  console.log(JSON.stringify(error, null, 2));
  return z.prettifyError(error);
};

const TemplateSchema = z.object({
  metadata: z.object({
    id: z.string().min(1).max(100).optional().default(crypto.randomUUID()),
    name: z.string().min(1).max(100), // name of the template
    description: z.string().min(1).max(1000), // description of the template
    author: z.string().min(1).max(20), // author of the template
    source: z
      .enum(['builtin', 'custom', 'external'])
      .optional()
      .default('builtin'),
    version: z
      .stringFormat('semver', /^[0-9]+\.[0-9]+\.[0-9]+$/)
      .optional()
      .default('1.0.0'),
    category: z.string().min(1).max(20), // category of the template
    services: z.array(z.enum(constants.SERVICES)).optional(),
    serviceRequired: z.boolean().optional(), // whether a service is required for this template or not.
  }),
  config: z.any(),
});

export interface TemplateValidation {
  isValid: boolean;
  warnings: string[];
  errors: string[];
}

interface TemplateInput {
  key: string; // Unique identifier for this input
  path: string | string[]; // Path in the userData object (e.g., "tmdbApiKey", "presets.0.options.apiKey", "proxy.url")
  label: string;
  description?: string;
  type: 'string' | 'password';
  required: boolean;
  value: string;
}

interface ProcessedTemplate {
  template: Template;
  services: string[]; // Selected services
  skipServiceSelection: boolean; // True if services = [] or single required service
  showServiceSelection: boolean; // True if services = undefined or multiple options
  allowSkipService: boolean; // True if serviceRequired = false
  inputs: TemplateInput[]; // All inputs needed
}

export interface ConfigTemplatesModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  openImportModal?: boolean;
}

export function ConfigTemplatesModal({
  open,
  onOpenChange,
  openImportModal = false,
}: ConfigTemplatesModalProps) {
  const { setUserData, userData } = useUserData();
  const { status } = useStatus();
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [isLoading, setIsLoading] = useState(false);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [templateValidations, setTemplateValidations] = useState<
    Record<string, TemplateValidation>
  >({});
  const [showImportModal, setShowImportModal] = useState(false);
  const [importUrl, setImportUrl] = useState('');
  const [isImporting, setIsImporting] = useState(false);
  const [showImportConfirmModal, setShowImportConfirmModal] = useState(false);
  const [pendingImportTemplates, setPendingImportTemplates] = useState<
    Template[]
  >([]);
  const [templateToDelete, setTemplateToDelete] = useState<Template | null>(
    null
  );

  // Template loading state
  const [processedTemplate, setProcessedTemplate] =
    useState<ProcessedTemplate | null>(null);
  const [currentStep, setCurrentStep] = useState<
    'browse' | 'selectService' | 'inputs'
  >('browse');
  const [selectedServices, setSelectedServices] = useState<string[]>([]);
  const [inputValues, setInputValues] = useState<Record<string, string>>({});

  // Fetch templates from API when modal opens
  useEffect(() => {
    if (open) {
      fetchTemplates();
      if (openImportModal) {
        setShowImportModal(true);
      }
    }
  }, [open]);

  // Load templates from localStorage
  const getLocalStorageTemplates = (): Template[] => {
    try {
      const stored = localStorage.getItem('aiostreams-custom-templates');
      if (stored) {
        const parsed = JSON.parse(stored);
        return parsed.map((template: any) => ({
          ...template,
          metadata: {
            ...template.metadata,
            source: 'external',
          },
        }));
      }
    } catch (error) {
      console.error('Error loading templates from localStorage:', error);
    }
    return [];
  };

  // Save templates to localStorage
  const saveLocalStorageTemplates = (templates: Template[]) => {
    try {
      localStorage.setItem(
        'aiostreams-custom-templates',
        JSON.stringify(templates)
      );
    } catch (error) {
      console.error('Error saving templates to localStorage:', error);
      toast.error('Failed to save templates to local storage');
    }
  };

  const fetchTemplates = async () => {
    setLoadingTemplates(true);
    try {
      const response = await fetch('/api/v1/templates');
      if (response.ok) {
        const data = await response.json();
        const fetchedTemplates = data.data || [];

        // Load external templates from localStorage
        const localTemplates = getLocalStorageTemplates();

        // Combine templates, removing duplicates based on ID
        // External templates come first to allow overwriting
        const allTemplates = [...localTemplates, ...fetchedTemplates];

        // Remove duplicates by ID, keeping the first occurrence (external templates have priority)
        const uniqueTemplates = allTemplates.reduce(
          (acc: Template[], template) => {
            const existingIndex = acc.findIndex(
              (t: Template) => t.metadata.id === template.metadata.id
            );
            if (existingIndex === -1) {
              acc.push(template);
            }
            return acc;
          },
          [] as Template[]
        );

        setTemplates(uniqueTemplates);

        // Validate all templates
        if (status) {
          const validations: Record<string, TemplateValidation> = {};
          uniqueTemplates.forEach((template: Template) => {
            validations[template.metadata.id] = validateTemplate(
              template,
              status
            );
          });
          setTemplateValidations(validations);
        }
      } else {
        toast.error('Failed to load templates');
      }
    } catch (error) {
      console.error('Error fetching templates:', error);
      toast.error('Failed to load templates');
    } finally {
      setLoadingTemplates(false);
    }
  };

  const validateTemplate = (
    template: Template,
    statusData: StatusResponse
  ): TemplateValidation => {
    const warnings: string[] = [];
    const errors: string[] = [];

    // Check if template has required structure
    if (!template.config) {
      errors.push('Template is missing configuration data');
      return { isValid: false, warnings, errors };
    }

    const validate = TemplateSchema.safeParse(template);
    if (!validate.success) {
      errors.push(formatZodError(validate.error));
      return { isValid: false, warnings, errors };
    }

    // Check if addons exist on instance
    if (template.config.presets) {
      const presetsToRemove: string[] = [];
      template.config.presets.forEach((preset: any) => {
        const presetMeta = statusData.settings?.presets?.find(
          (p) => p.ID === preset.type
        );
        if (!presetMeta || presetMeta.DISABLED?.disabled) {
          warnings.push(
            `"${preset.type}" is not available or disabled on this instance.`
          );
          presetsToRemove.push(preset.type);
        }
      });
      template.config.presets = template.config.presets.filter(
        (p) => !presetsToRemove.includes(p.type)
      );
    }

    // Check if services exist on instance
    const availableServices = Object.keys(statusData.settings?.services || {});
    if (template.config.services) {
      template.config.services.forEach((service: any) => {
        if (!availableServices.includes(service.id)) {
          warnings.push(
            `Service "${service.id}" not available on this instance`
          );
        }
      });
    }

    if (template.metadata.source === 'external') {
      const excludedRegexes = template.config.excludedRegexPatterns || [];
      const includedRegexes = template.config.includedRegexPatterns || [];
      const requiredRegexes = template.config.requiredRegexPatterns || [];
      const preferredRegexes = (template.config.preferredRegexPatterns || []).map(
        (r) => (typeof r === 'string' ? r : r.pattern)
      );

      const allRegexes = [
        ...excludedRegexes,
        ...includedRegexes,
        ...requiredRegexes,
        ...preferredRegexes,
      ];

      if (allRegexes.length > 0) {
        const allowedPatterns =
          statusData.settings?.allowedRegexPatterns?.patterns || [];

        if (
          statusData.settings?.regexFilterAccess === 'none' &&
          allowedPatterns.length === 0
        ) {
          warnings.push(
            'Template uses regex patterns but regex access is disabled on this instance'
          );
        } else if (statusData.settings?.regexFilterAccess !== 'all') {
          const unsupportedPatterns = allRegexes.filter(
            (pattern) => !allowedPatterns.includes(pattern)
          );

          if (unsupportedPatterns.length > 0) {
            warnings.push(
              `Template has ${unsupportedPatterns.length} regex patterns that are not trusted.`
            );
          }
        }
      }
    }

    const isValid = errors.length === 0;
    return { isValid, warnings, errors };
  };

  const categories = [
    'all',
    ...Array.from(new Set(templates.map((t) => t.metadata.category))),
  ];

  const filteredTemplates = templates.filter((template) => {
    const matchesSearch =
      template.metadata.name
        .toLowerCase()
        .includes(searchQuery.toLowerCase()) ||
      template.metadata.description
        .toLowerCase()
        .includes(searchQuery.toLowerCase()) ||
      template.metadata.services?.some((service) =>
        service.toLowerCase().includes(searchQuery.toLowerCase())
      );

    const matchesCategory =
      selectedCategory === 'all' ||
      template.metadata.category === selectedCategory;

    return matchesSearch && matchesCategory;
  });

  const processImportedTemplate = (data: any) => {
    try {
      // Check if data is an array of templates
      const isArray = Array.isArray(data);
      const templateData = isArray ? data : [data];

      const importedTemplates: Template[] = [];
      const protectedTemplateIds: string[] = [];

      for (const item of templateData) {
        // Validate it has config field
        if (!item.config) {
          toast.error('Invalid template: missing config field');
          return;
        }

        // Generate ID if not provided
        const templateId =
          item.metadata?.id ||
          `imported-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        // Check if this would overwrite a built-in or custom template
        const existingTemplate = templates.find(
          (t) => t.metadata.id === templateId
        );
        if (
          existingTemplate &&
          (existingTemplate.metadata.source === 'builtin' ||
            existingTemplate.metadata.source === 'custom')
        ) {
          protectedTemplateIds.push(templateId);
          continue; // Skip this template
        }

        // Create a template object from the data
        const importedTemplate: Template = {
          metadata: {
            id: templateId,
            name: item.metadata?.name || 'Imported Template',
            description: item.metadata?.description || 'Imported from JSON',
            author: item.metadata?.author || 'Unknown',
            version: item.metadata?.version || '1.0.0',
            category: item.metadata?.category || 'Custom',
            services: item.metadata?.services,
            serviceRequired: item.metadata?.serviceRequired,
            source: 'external',
          },
          config: item.config || item,
        };

        // Validate the imported template
        if (status) {
          const validation = validateTemplate(importedTemplate, status);

          if (validation.errors.length > 0) {
            toast.error(
              `Cannot import template "${importedTemplate.metadata.name}": ${validation.errors.join(', ')}`
            );
            return;
          }

          setTemplateValidations((prev) => ({
            ...prev,
            [importedTemplate.metadata.id]: validation,
          }));
        }

        importedTemplates.push(importedTemplate);
      }

      // Show error if any templates were blocked
      if (protectedTemplateIds.length > 0) {
        toast.error(
          `Cannot overwrite built-in or custom templates: ${protectedTemplateIds.join(', ')}`
        );
        if (importedTemplates.length === 0) {
          return; // No templates to import
        }
      }

      // Close import modal and show confirmation modal
      setShowImportModal(false);
      setImportUrl('');
      setPendingImportTemplates(importedTemplates);
      setShowImportConfirmModal(true);
    } catch (error) {
      toast.error('Invalid template format: ' + (error as Error).message);
    }
  };

  const handleImportFromUrl = async () => {
    if (!importUrl.trim()) {
      toast.error('Please enter a URL');
      return;
    }

    setIsImporting(true);
    try {
      const response = await fetch(importUrl);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const data = await response.json();
      processImportedTemplate(data);
    } catch (error) {
      toast.error('Failed to import template: ' + (error as Error).message);
    } finally {
      setIsImporting(false);
    }
  };

  const handleImportFromFile = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;

      try {
        const text = await file.text();
        const data = JSON.parse(text);
        processImportedTemplate(data);
      } catch (error) {
        toast.error('Failed to read file: ' + (error as Error).message);
      }
    };
    input.click();
  };

  const handleConfirmImport = (loadImmediately = false) => {
    // Save to localStorage, overwriting templates with the same ID
    const localTemplates = getLocalStorageTemplates();

    // Remove any existing templates with the same IDs
    const existingTemplateIds = new Set(
      pendingImportTemplates.map((t) => t.metadata.id)
    );
    const filteredLocalTemplates = localTemplates.filter(
      (t) => !existingTemplateIds.has(t.metadata.id)
    );

    const updatedTemplates = [
      ...filteredLocalTemplates,
      ...pendingImportTemplates,
    ];
    saveLocalStorageTemplates(updatedTemplates);

    // Update current templates list, removing duplicates
    setTemplates((prev) => {
      const filtered = prev.filter(
        (t) => !existingTemplateIds.has(t.metadata.id)
      );
      return [...filtered, ...pendingImportTemplates];
    });

    const overwriteCount = localTemplates.filter((t) =>
      existingTemplateIds.has(t.metadata.id)
    ).length;

    if (overwriteCount > 0) {
      toast.success(
        `Successfully imported ${pendingImportTemplates.length} template${pendingImportTemplates.length !== 1 ? 's' : ''} (${overwriteCount} overwritten)`
      );
    } else {
      toast.success(
        `Successfully imported ${pendingImportTemplates.length} template${pendingImportTemplates.length !== 1 ? 's' : ''}`
      );
    }

    // If user wants to load immediately (single template only)
    if (loadImmediately && pendingImportTemplates.length === 1) {
      setShowImportConfirmModal(false);
      handleLoadTemplate(pendingImportTemplates[0]);
      setPendingImportTemplates([]);
    } else {
      setShowImportConfirmModal(false);
      setPendingImportTemplates([]);
    }
  };

  const handleCancelImport = () => {
    setShowImportConfirmModal(false);
    setPendingImportTemplates([]);
  };

  const handleDeleteTemplate = (templateId: string) => {
    // Remove from current templates list
    setTemplates((prev) => prev.filter((t) => t.metadata.id !== templateId));

    // Remove from localStorage
    const localTemplates = getLocalStorageTemplates();
    const updatedTemplates = localTemplates.filter(
      (t) => t.metadata.id !== templateId
    );
    saveLocalStorageTemplates(updatedTemplates);

    toast.success('Template deleted successfully');
  };

  const confirmDeleteTemplate = useConfirmationDialog({
    title: 'Delete Template',
    description:
      'Are you sure you want to delete this template? This action cannot be undone.',
    actionText: 'Delete',
    actionIntent: 'alert-subtle',
    onConfirm: () => {
      if (templateToDelete) {
        handleDeleteTemplate(templateToDelete.metadata.id);
      }
    },
  });

  // Parse placeholder values from a string
  const parsePlaceholder = (
    value: any
  ): { isPlaceholder: boolean; required: boolean } => {
    if (typeof value !== 'string')
      return { isPlaceholder: false, required: false };

    const placeholderPatterns = [
      { pattern: /<required_template_placeholder>/gi, required: true },
      { pattern: /<optional_template_placeholder>/gi, required: false },
      { pattern: /<template_placeholder>/gi, required: true }, // default to required
    ];

    for (const { pattern, required } of placeholderPatterns) {
      if (pattern.test(value)) {
        return { isPlaceholder: true, required };
      }
    }

    // // Also check for empty string or common placeholder patterns
    // if (
    //   !value ||
    //   value === '' ||
    //   value === '<ENTER_YOUR_API_KEY>' ||
    //   value === '<ENTER_VALUE>'
    // ) {
    //   return { isPlaceholder: true, required: false };
    // }

    return { isPlaceholder: false, required: false };
  };

  // Process template to extract all inputs and determine service handling
  const processTemplate = (template: Template): ProcessedTemplate => {
    const inputs: TemplateInput[] = [];
    const availableServices = Object.keys(status?.settings?.services || {});

    // Determine service handling based on services array and serviceRequired
    let services: string[] = [];
    let skipServiceSelection = false;
    let showServiceSelection = false;
    let allowSkipService = template.metadata.serviceRequired !== true;

    if (template.metadata.services === undefined) {
      // Show all available services
      showServiceSelection = true;
      services = availableServices;
    } else if (
      Array.isArray(template.metadata.services) &&
      template.metadata.services.length === 0
    ) {
      // Skip service selection entirely
      skipServiceSelection = true;
      services = [];
    } else if (Array.isArray(template.metadata.services)) {
      // Filter to only services available on this instance
      services = template.metadata.services.filter((s) =>
        availableServices.includes(s)
      );

      if (services.length === 1 && template.metadata.serviceRequired === true) {
        // Single required service - skip selection, add to inputs
        skipServiceSelection = true;
      } else if (services.length > 0) {
        // Multiple services or optional - show selection
        showServiceSelection = true;
      } else {
        // No valid services
        skipServiceSelection = true;
      }
    }

    // Parse proxy fields
    if (template.config?.proxy && template.config.proxy.id) {
      const id = template.config.proxy.id;
      const proxyDetails = constants.PROXY_SERVICE_DETAILS[id];
      const proxyFields = [
        'url',
        'publicUrl',
        'credentials',
        'publicIp',
      ] as const;

      proxyFields.forEach((field) => {
        const value = template.config.proxy?.[field];
        const placeholder = parsePlaceholder(value);

        if (placeholder.isPlaceholder) {
          const fieldLabels: Record<string, string> = {
            url: `${proxyDetails.name} URL`,
            publicUrl: `${proxyDetails.name} Public URL`,
            credentials: `${proxyDetails.name} Credentials`,
            publicIp: `${proxyDetails.name} Public IP`,
          };

          const fieldDescriptions: Record<string, string> = {
            url: `The URL of your ${proxyDetails.name} instance`,
            publicUrl: `The public URL of your ${proxyDetails.name} instance (if different from URL)`,
            credentials: proxyDetails.credentialDescription,
            publicIp: `Public IP address of your ${proxyDetails.name} instance`,
          };

          inputs.push({
            key: `proxy_${field}`,
            path: `proxy.${field}`,
            label: fieldLabels[field] || field,
            description: fieldDescriptions[field],
            type: field === 'credentials' ? 'password' : 'string',
            required: placeholder.required,
            value: userData?.proxy?.[field] || '',
          });
        }
      });
    }

    // Parse top-level API keys
    const topLevelFields = [
      'tmdbApiKey',
      'tmdbAccessToken',
      'tvdbApiKey',
      'rpdbApiKey',
    ] as const;

    topLevelFields.forEach((field) => {
      const value = template.config?.[field];
      const placeholder = parsePlaceholder(value);

      if (placeholder.isPlaceholder) {
        const detail = constants.TOP_LEVEL_OPTION_DETAILS?.[field];
        inputs.push({
          key: `toplevel_${field}`,
          path: field,
          label: detail?.name || field,
          description: detail?.description,
          type: 'password',
          required: placeholder.required,
          value: userData?.[field] || '',
        });
      }
    });

    // Parse preset options
    template.config?.presets?.forEach((preset: any, presetIndex: number) => {
      const presetMeta = status?.settings?.presets?.find(
        (p: any) => p.ID === preset.type
      );

      if (!presetMeta) return;

      // Check all string/password options
      presetMeta.OPTIONS?.forEach((option: any) => {
        if (option.type === 'string' || option.type === 'password') {
          const currentValue = preset.options?.[option.id];
          const placeholder = parsePlaceholder(currentValue);

          if (placeholder.isPlaceholder || (option.required && !currentValue)) {
            if (option.id === 'debridioApiKey') {
              const debridioApiKeyInput = inputs.find(
                (input) => input.key === 'debridioApiKey'
              );
              if (debridioApiKeyInput) {
                if (Array.isArray(debridioApiKeyInput.path)) {
                  debridioApiKeyInput.path.push(
                    `presets.${presetIndex}.options.${option.id}`
                  );
                } else {
                  debridioApiKeyInput.path = [
                    debridioApiKeyInput.path,
                    `presets.${presetIndex}.options.${option.id}`,
                  ];
                }
              } else {
                inputs.push({
                  key: 'debridioApiKey',
                  path: `presets.${presetIndex}.options.${option.id}`,
                  label: 'Debridio API Key',
                  description: option.description,
                  type: 'password',
                  required: true,
                  value:
                    userData?.presets?.[presetIndex]?.options?.[option.id] ||
                    '',
                });
              }
            } else {
              inputs.push({
                key: `preset_${preset.instanceId}_${option.id}`,
                path: `presets.${presetIndex}.options.${option.id}`,
                label: `${preset.options?.name || preset.type} - ${option.name || option.id}`,
                description: option.description,
                type: option.type === 'password' ? 'password' : 'string',
                required: placeholder.required || option.required || false,
                value:
                  userData?.presets?.[presetIndex]?.options?.[option.id] || '',
              });
            }
          }
        }
      });
    });

    return {
      template,
      services,
      skipServiceSelection,
      showServiceSelection,
      allowSkipService,
      inputs,
    };
  };

  // Add service credentials to inputs
  const addServiceInputs = (
    processed: ProcessedTemplate,
    selectedServiceIds: string[]
  ): TemplateInput[] => {
    const serviceInputs: TemplateInput[] = [];

    selectedServiceIds.forEach((serviceId) => {
      const serviceMeta =
        status?.settings?.services?.[
          serviceId as keyof typeof status.settings.services
        ];
      if (!serviceMeta?.credentials) return;

      serviceMeta.credentials.forEach((cred: any) => {
        serviceInputs.push({
          key: `service_${serviceId}_${cred.id}`,
          path: `services.${serviceId}.${cred.id}`,
          label: `${serviceMeta.name} - ${cred.name || cred.id}`,
          description: cred.description,
          type: 'password',
          required: true,
          value:
            userData?.services?.find((s: any) => s.id === serviceId)
              ?.credentials?.[cred.id] || '',
        });
      });
    });

    return serviceInputs;
  };

  const handleLoadTemplate = (template: Template) => {
    // Show validation warnings if any
    const validation = templateValidations[template.metadata.id];
    if (validation && validation.errors.length > 0) {
      toast.error(`Cannot load template: ${validation.errors.join(', ')}`);
      return;
    }

    if (validation && validation.warnings.length > 0) {
      toast.warning(
        `Template has warnings: ${validation.warnings.slice(0, 2).join(', ')}${validation.warnings.length > 2 ? '...' : ''}`,
        {
          duration: 5000,
        }
      );
    }

    const processed = processTemplate(template);
    setProcessedTemplate(processed);

    // Determine which step to show
    if (processed.skipServiceSelection) {
      // If single required service, add its credentials to inputs (only if the template says service is required)
      if (processed.services.length === 1) {
        const serviceInputs = addServiceInputs(processed, processed.services);
        processed.inputs = [...serviceInputs, ...processed.inputs];
        setSelectedServices(processed.services);
      }

      // Go directly to inputs
      setInputValues(
        processed.inputs.reduce(
          (acc, input) => ({ ...acc, [input.key]: input.value }),
          {}
        )
      );
      setCurrentStep('inputs');
    } else if (processed.showServiceSelection) {
      // Show service selection
      setSelectedServices([]);
      setCurrentStep('selectService');
    } else {
      // No services, go directly to inputs
      setInputValues(
        processed.inputs.reduce(
          (acc, input) => ({ ...acc, [input.key]: input.value }),
          {}
        )
      );
      setCurrentStep('inputs');
    }
  };

  const handleServiceSelectionNext = () => {
    if (!processedTemplate) return;

    // Validate at least one service if required
    if (!processedTemplate.allowSkipService && selectedServices.length === 0) {
      toast.error('Please select at least one service');
      return;
    }

    // Add service inputs
    const serviceInputs = addServiceInputs(processedTemplate, selectedServices);
    const allInputs = [...serviceInputs, ...processedTemplate.inputs];
    processedTemplate.inputs = allInputs;

    // Initialize input values
    setInputValues(
      allInputs.reduce(
        (acc, input) => ({ ...acc, [input.key]: input.value }),
        {}
      )
    );
    setCurrentStep('inputs');
  };

  const handleServiceSelectionSkip = () => {
    if (!processedTemplate) return;

    if (!processedTemplate.allowSkipService) {
      toast.error('Service selection cannot be skipped for this template');
      return;
    }

    setSelectedServices([]);
    setInputValues(
      processedTemplate.inputs.reduce(
        (acc, input) => ({ ...acc, [input.key]: input.value }),
        {}
      )
    );
    setCurrentStep('inputs');
  };

  const applyInputValue = (obj: any, path: string, value: any) => {
    const parts = path.split('.');
    let current = obj;

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      const nextPart = parts[i + 1];

      // Check if next part is a number (array index)
      const isArrayIndex = /^\d+$/.test(nextPart);

      if (!(part in current)) {
        current[part] = isArrayIndex ? [] : {};
      }
      current = current[part];
    }

    current[parts[parts.length - 1]] = value;
  };

  const confirmLoadTemplate = async () => {
    if (!processedTemplate) return;

    // Validate required inputs
    const missingRequired = processedTemplate.inputs.filter(
      (input) => input.required && !inputValues[input.key]?.trim()
    );

    if (missingRequired.length > 0) {
      toast.error(
        `Please fill in all required fields: ${missingRequired.map((i) => i.label).join(', ')}`
      );
      return;
    }

    setIsLoading(true);
    try {
      // Clone the userData
      const migratedData = applyMigrations(
        JSON.parse(JSON.stringify(processedTemplate.template.config))
      );

      // Apply all input values
      processedTemplate.inputs.forEach((input) => {
        const value = inputValues[input.key];
        if (value) {
          // Handle service credentials separately
          const paths = Array.isArray(input.path) ? input.path : [input.path];
          for (const path of paths) {
            if (path.startsWith('services.')) {
              const pathParts = path.split('.');
              const serviceId = pathParts[1] as any;
              const credKey = pathParts[2];

              // Find or create service in userData
              if (!migratedData.services) {
                migratedData.services = [];
              }

              let service = migratedData.services.find(
                (s: any) => s.id === serviceId
              );

              if (!service) {
                service = {
                  id: serviceId,
                  enabled: true,
                  credentials: {},
                };
                migratedData.services.push(service);
              }

              if (!service.credentials) {
                service.credentials = {};
              }

              service.credentials[credKey] = value;
            } else {
              // Apply to regular path
              applyInputValue(migratedData, path, value);
            }
          }
        }
      });

      // Filter services to only selected ones
      if (selectedServices.length > 0 && migratedData.services) {
        migratedData.services = migratedData.services.filter((s: any) =>
          selectedServices.includes(s.id)
        );
      }

      setUserData((prev) => ({
        ...prev,
        ...migratedData,
        templateSource: processedTemplate.template.metadata.source,
      }));

      // Check if there are any addons that need manual setup
      const addonsNeedingSetup = (migratedData.presets || [])
        .filter((preset: any) => {
          const presetType = preset.type.toLowerCase();
          // List of addons that need manual setup
          return ['gdrive'].some((type) => presetType.includes(type));
        })
        .map((preset: any) => preset.options?.name || preset.type);

      toast.success(
        `Template "${processedTemplate.template.metadata.name}" loaded successfully`
      );

      // Show additional guidance if needed
      if (addonsNeedingSetup.length > 0) {
        setTimeout(() => {
          toast.info(
            `Note: ${addonsNeedingSetup.join(', ')} require additional setup. Please configure them in the Addons section.`,
            { duration: 8000 }
          );
        }, 1000);
      }

      // Reset state
      setProcessedTemplate(null);
      setCurrentStep('browse');
      setSelectedServices([]);
      setInputValues({});
      onOpenChange(false);
    } catch (err) {
      console.error('Error loading template:', err);
      toast.error('Failed to load template');
    } finally {
      setIsLoading(false);
    }
  };

  const handleBackFromInputs = () => {
    if (!processedTemplate) return;

    if (processedTemplate.showServiceSelection) {
      // Go back to service selection
      // Remove service inputs from the list
      const nonServiceInputs = processedTemplate.inputs.filter((input) =>
        Array.isArray(input.path)
          ? !input.path.some((p) => p.startsWith('services.'))
          : !input.path.startsWith('services.')
      );
      processedTemplate.inputs = nonServiceInputs;
      setCurrentStep('selectService');
    } else {
      // Go back to browse
      setProcessedTemplate(null);
      setCurrentStep('browse');
      setSelectedServices([]);
      setInputValues({});
    }
  };

  const handleCancel = () => {
    setProcessedTemplate(null);
    setCurrentStep('browse');
    setSelectedServices([]);
    setInputValues({});
    onOpenChange(false);
  };

  // Render different steps
  const renderBrowse = () => (
    <>
      {/* Search and Filter */}
      <div className="flex flex-wrap gap-2">
        <div className="w-full sm:basis-auto sm:flex-1 order-1">
          <TextInput
            placeholder="Search templates..."
            value={searchQuery}
            onValueChange={setSearchQuery}
            leftIcon={<SearchIcon className="w-4 h-4" />}
          />
        </div>
        <div className="w-full sm:basis-1/2 sm:flex-none order-2 flex flex-wrap gap-1.5">
          {categories.map((category) => (
            <Button
              key={category}
              intent={
                selectedCategory === category ? 'primary' : 'gray-outline'
              }
              size="sm"
              onClick={() => setSelectedCategory(category)}
              className="whitespace-nowrap"
            >
              {category.charAt(0).toUpperCase() + category.slice(1)}
            </Button>
          ))}
        </div>
      </div>

      {/* Templates List */}
      <div className="space-y-3 max-h-[450px] overflow-y-auto pr-2">
        {loadingTemplates ? (
          <div className="text-center py-8 text-gray-400">
            Loading templates...
          </div>
        ) : filteredTemplates.length === 0 ? (
          <div className="text-center py-8 text-gray-400">
            No templates found matching your search
          </div>
        ) : (
          filteredTemplates.map((template) => {
            const validation = templateValidations[template.metadata.id];
            const hasWarnings = validation && validation.warnings.length > 0;
            const hasErrors = validation && validation.errors.length > 0;

            const addons = Array.from(
              new Set(
                template.config.presets?.map(
                  (preset: any) => preset.options?.name
                )
              )
            );

            return (
              <div
                key={template.metadata.id}
                className="bg-gray-900 border border-gray-800 rounded-lg p-4 hover:border-gray-700 transition-colors"
              >
                <div className="flex items-start gap-2 mb-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="text-base font-semibold text-white truncate">
                        {template.metadata.name}
                      </h3>
                      <span className="text-[10px] text-gray-400 bg-gray-800 px-1.5 py-0.5 rounded flex-shrink-0">
                        v{template.metadata.version || '1.0.0'}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {template.metadata.source === 'builtin' && (
                      <span className="text-xs bg-blue-500/20 text-blue-300 px-2 py-0.5 rounded border border-blue-500/30">
                        Built-in
                      </span>
                    )}
                    {template.metadata.source === 'custom' && (
                      <span className="text-xs bg-purple-500/20 text-purple-300 px-2 py-0.5 rounded border border-purple-500/30">
                        Custom
                      </span>
                    )}
                    {template.metadata.source === 'external' && (
                      <span className="text-xs bg-emerald-500/20 text-emerald-300 px-2 py-0.5 rounded border border-emerald-500/30">
                        External
                      </span>
                    )}
                    {(hasWarnings || hasErrors) && (
                      <div className="relative group">
                        <AlertTriangleIcon
                          className={`w-4 h-4 ${hasErrors ? 'text-red-400' : 'text-yellow-400'}`}
                        />
                        <div className="absolute right-0 top-full mt-1 w-64 max-w-[calc(100vw-2rem)] p-2 bg-gray-900 border border-gray-700 rounded-lg shadow-lg opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-50 text-xs">
                          {validation.errors.length > 0 && (
                            <div className="mb-2">
                              <div className="font-semibold text-red-400 mb-1">
                                Errors:
                              </div>
                              <ul className="list-disc list-inside space-y-1 text-red-300">
                                {validation.errors.map((error, idx) => (
                                  <li key={idx} className="break-words">
                                    {error}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                          {validation.warnings.length > 0 && (
                            <div>
                              <div className="font-semibold text-yellow-400 mb-1">
                                Warnings:
                              </div>
                              <ul className="list-disc list-inside space-y-1 text-yellow-300">
                                {validation.warnings.map((warning, idx) => (
                                  <li key={idx} className="break-words">
                                    {warning}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                <MarkdownLite className="text-sm text-gray-400 mb-4">
                  {template.metadata.description}
                </MarkdownLite>

                {/* Category and Author */}
                <div className="grid grid-cols-2 gap-3 text-sm mb-3">
                  <div>
                    <div className="text-gray-500 text-xs mb-1.5">Category</div>
                    <span className="text-xs bg-gray-800/60 text-gray-300 px-2 py-1 rounded inline-block">
                      {template.metadata.category}
                    </span>
                  </div>

                  <div>
                    <div className="text-gray-500 text-xs mb-1.5">Author</div>
                    <span className="text-xs text-gray-300">
                      {template.metadata.author}
                    </span>
                  </div>
                </div>

                {/* Addons */}
                {addons.length > 0 && (
                  <div className="mb-3">
                    <div className="text-gray-500 text-xs mb-1.5">Addons</div>
                    <div className="flex flex-wrap gap-1.5">
                      {addons.slice(0, 5).map((addon) => (
                        <span
                          key={addon}
                          className="text-xs bg-blue-600/30 text-blue-300 px-2 py-0.5 rounded"
                        >
                          {addon}
                        </span>
                      ))}
                      {addons.length > 5 && (
                        <div className="relative group">
                          <span className="text-xs bg-blue-600/30 text-blue-300 px-2 py-0.5 rounded cursor-pointer">
                            +{addons.length - 5} more
                          </span>
                          <div className="absolute left-0 top-full mt-1 z-50 opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200">
                            <div className="bg-gray-900 border border-gray-700 rounded-lg shadow-lg p-2 flex flex-wrap gap-1.5 max-w-xs">
                              {addons.slice(5).map((addon, idx) => (
                                <span
                                  key={addon}
                                  className="text-xs bg-blue-600/30 text-blue-300 px-2 py-0.5 rounded animate-in fade-in slide-in-from-top-1"
                                  style={{
                                    animationDelay: `${idx * 30}ms`,
                                    animationDuration: '200ms',
                                  }}
                                >
                                  {addon}
                                </span>
                              ))}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Services */}
                {template.metadata.services &&
                  template.metadata.services.length > 0 && (
                    <div className="mb-3">
                      <div className="text-gray-500 text-xs mb-1.5">
                        Services
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {template.metadata.services.map((service) => (
                          <span
                            key={service}
                            className="text-xs bg-green-600/30 text-green-300 px-2 py-0.5 rounded"
                          >
                            {constants.SERVICE_DETAILS[
                              service as keyof typeof constants.SERVICE_DETAILS
                            ]?.name || service}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                {/* Load Template Button - Full Width at Bottom */}
                <div className="flex gap-2">
                  {template.metadata.source === 'external' && (
                    <IconButton
                      icon={<Trash2Icon className="w-4 h-4" />}
                      intent="alert-outline"
                      onClick={(e) => {
                        e.stopPropagation();
                        setTemplateToDelete(template);
                        confirmDeleteTemplate.open();
                      }}
                    />
                  )}
                  <Button
                    intent="primary"
                    size="md"
                    leftIcon={<CheckIcon className="w-4 h-4" />}
                    onClick={() => handleLoadTemplate(template)}
                    loading={isLoading}
                    className="flex-1"
                  >
                    Load Template
                  </Button>
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="flex justify-between items-center pt-2 border-t border-gray-700">
        <div className="text-sm text-gray-400">
          {filteredTemplates.length} template
          {filteredTemplates.length !== 1 ? 's' : ''} available
        </div>
        <div className="flex gap-2">
          <IconButton
            icon={<BiImport />}
            intent="primary-outline"
            onClick={() => setShowImportModal(true)}
          />
          <Button intent="primary-outline" onClick={handleCancel}>
            Close
          </Button>
        </div>
      </div>
    </>
  );

  const renderServiceSelection = () => {
    if (!processedTemplate) return null;

    return (
      <>
        <Alert
          intent="info"
          description={
            processedTemplate.allowSkipService
              ? 'Select the services you want to use with this template. You can skip this step if services are not needed.'
              : 'Select the services you want to use with this template.'
          }
        />

        <div className="space-y-2 max-h-[400px] overflow-y-auto pr-2">
          {processedTemplate.services.map((serviceId) => {
            const service =
              status?.settings?.services?.[
                serviceId as keyof typeof status.settings.services
              ];
            if (!service) return null;

            const isSelected = selectedServices.includes(serviceId);
            return (
              <button
                key={serviceId}
                onClick={() => {
                  setSelectedServices((prev) =>
                    prev.includes(serviceId)
                      ? prev.filter((s) => s !== serviceId)
                      : [...prev, serviceId]
                  );
                }}
                className={`w-full p-3 rounded-lg border-2 text-left transition-colors ${
                  isSelected
                    ? 'border-[--brand] bg-brand-400/20'
                    : 'border-gray-700 bg-gray-800/50 hover:border-gray-600'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex-1">
                    <div className="font-semibold text-white">
                      {service.name}
                    </div>
                    {service.signUpText && (
                      <MarkdownLite
                        className="text-sm text-[--muted] mt-1"
                        stopPropagation
                      >
                        {service.signUpText}
                      </MarkdownLite>
                    )}
                  </div>
                  {isSelected && (
                    <CheckIcon className="w-5 h-5 text-[--brand] flex-shrink-0 ml-2" />
                  )}
                </div>
              </button>
            );
          })}
        </div>

        <div className="flex justify-between gap-2 pt-2 border-t border-gray-700">
          <Button intent="primary-outline" onClick={handleCancel}>
            Cancel
          </Button>
          <div className="flex gap-2">
            {processedTemplate.allowSkipService && (
              <Button
                intent="gray-outline"
                onClick={handleServiceSelectionSkip}
              >
                Skip
              </Button>
            )}
            <Button
              intent="white"
              rounded
              onClick={handleServiceSelectionNext}
              disabled={
                !processedTemplate.allowSkipService &&
                selectedServices.length === 0
              }
            >
              Next
            </Button>
          </div>
        </div>
      </>
    );
  };

  const renderInputs = () => {
    if (!processedTemplate) return null;

    return (
      <>
        <Alert
          intent="info"
          description="Enter your API keys and credentials below. Some addons may require additional setup in the Addons section after loading."
        />

        <form className="space-y-3 max-h-[400px] overflow-y-auto pr-2">
          {processedTemplate.inputs.length === 0 ? (
            <div className="text-center py-4 text-gray-400 text-sm">
              No inputs required for this template
            </div>
          ) : (
            processedTemplate.inputs.map((input) => {
              const props = {
                label: input.label,
                value: inputValues[input.key] || '',
                placeholder: `Enter ${input.label}...`,
                onValueChange: (newValue: string) => {
                  setInputValues((prev) => ({
                    ...prev,
                    [input.key]: newValue,
                  }));
                },
                required: input.required,
              };
              return (
                <React.Fragment key={input.key}>
                  {input.type === 'string' ? (
                    <TextInput {...props} />
                  ) : (
                    <PasswordInput {...props} />
                  )}
                  {input.description && (
                    <MarkdownLite className="text-xs text-[--muted] mt-1">
                      {input.description}
                    </MarkdownLite>
                  )}
                </React.Fragment>
              );
            })
          )}
        </form>

        <div className="flex justify-between gap-2 pt-2 border-t border-gray-700">
          <Button intent="primary-outline" onClick={handleBackFromInputs}>
            Back
          </Button>
          <Button
            intent="white"
            rounded
            onClick={confirmLoadTemplate}
            loading={isLoading}
            disabled={processedTemplate.inputs.some(
              (input) => input.required && !inputValues[input.key]?.trim()
            )}
          >
            Load Template
          </Button>
        </div>
      </>
    );
  };

  return (
    <>
      <Modal
        open={open && currentStep === 'browse'}
        onOpenChange={(isOpen) => {
          if (!isOpen) handleCancel();
        }}
        title="Templates"
        description="Browse and load pre-configured templates for your AIOStreams setup"
      >
        <div className="space-y-4">{renderBrowse()}</div>
      </Modal>

      {/* Service Selection Modal */}
      <Modal
        open={open && currentStep === 'selectService'}
        onOpenChange={(isOpen) => {
          if (!isOpen) handleCancel();
        }}
        title="Select Services"
        description="Choose which services you want to use with this template"
      >
        <div className="space-y-4">{renderServiceSelection()}</div>
      </Modal>

      {/* Inputs Modal */}
      <Modal
        open={open && currentStep === 'inputs'}
        onOpenChange={(isOpen) => {
          if (!isOpen) handleCancel();
        }}
        title="Enter Credentials"
        description="Provide your API keys and credentials for the selected services and addons"
      >
        <div className="space-y-4">{renderInputs()}</div>
      </Modal>

      {/* Import Template Modal */}
      <Modal
        open={showImportModal}
        onOpenChange={setShowImportModal}
        title="Import Template"
        description="Import a template from a URL or local file"
      >
        <div className="space-y-4">
          {/* URL Import */}
          <div className="flex gap-2">
            <TextInput
              placeholder="Enter template URL..."
              value={importUrl}
              onValueChange={setImportUrl}
              className="flex-1"
            />
            <Button
              intent="primary"
              onClick={handleImportFromUrl}
              loading={isImporting}
              disabled={!importUrl.trim()}
            >
              Go
            </Button>
          </div>

          {/* Separator */}
          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-gray-700" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-gray-900 px-2 text-gray-400">or</span>
            </div>
          </div>

          {/* File Import */}
          <Button
            intent="primary"
            className="w-full"
            leftIcon={<BiImport className="w-4 h-4" />}
            onClick={handleImportFromFile}
          >
            Import from File
          </Button>

          <div className="flex justify-end gap-2 pt-2">
            <Button
              intent="primary-outline"
              onClick={() => {
                setShowImportModal(false);
                setImportUrl('');
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      </Modal>

      {/* Import Confirmation Modal */}
      <Modal
        open={showImportConfirmModal}
        onOpenChange={setShowImportConfirmModal}
        title="Confirm Import"
        description={
          pendingImportTemplates.length === 1
            ? 'Review the template details before importing'
            : `${pendingImportTemplates.length} templates will be imported`
        }
      >
        <div className="space-y-4">
          {pendingImportTemplates.length === 1 ? (
            // Show detailed metadata for single template
            <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-4 space-y-3">
              <div>
                <div className="text-xs text-gray-400 mb-1">Name</div>
                <div className="text-sm font-semibold text-white flex items-center gap-2">
                  {pendingImportTemplates[0].metadata.name}
                  <span className="text-[10px] text-gray-400 bg-gray-800 px-1.5 py-0.5 rounded">
                    v{pendingImportTemplates[0].metadata.version || '1.0.0'}
                  </span>
                </div>
              </div>
              <div>
                <div className="text-xs text-gray-400 mb-1">Description</div>
                <MarkdownLite className="text-sm text-gray-300">
                  {pendingImportTemplates[0].metadata.description}
                </MarkdownLite>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="text-xs text-gray-400 mb-1">Author</div>
                  <div className="text-sm text-gray-300">
                    {pendingImportTemplates[0].metadata.author}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-gray-400 mb-1">Category</div>
                  <div className="text-sm text-gray-300">
                    {pendingImportTemplates[0].metadata.category}
                  </div>
                </div>
              </div>
              {pendingImportTemplates[0].metadata.services &&
                pendingImportTemplates[0].metadata.services.length > 0 && (
                  <div>
                    <div className="text-xs text-gray-400 mb-1">Services</div>
                    <div className="flex flex-wrap gap-1.5">
                      {pendingImportTemplates[0].metadata.services.map(
                        (service) => (
                          <span
                            key={service}
                            className="text-xs bg-green-600/30 text-green-300 px-2 py-0.5 rounded"
                          >
                            {constants.SERVICE_DETAILS[
                              service as keyof typeof constants.SERVICE_DETAILS
                            ]?.name || service}
                          </span>
                        )
                      )}
                    </div>
                  </div>
                )}
            </div>
          ) : (
            // Show simple list for multiple templates
            <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-4">
              <div className="space-y-2 max-h-[300px] overflow-y-auto">
                {pendingImportTemplates.map((template, idx) => (
                  <div
                    key={idx}
                    className="flex items-center justify-between py-2 border-b border-gray-700 last:border-0"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-white truncate">
                        {template.metadata.name}
                      </div>
                      <div className="text-xs text-gray-400 truncate">
                        {template.metadata.category} • v
                        {template.metadata.version || '1.0.0'}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <Alert
            intent="info"
            description={`The template${pendingImportTemplates.length !== 1 ? 's' : ''} will be saved to your browser's local storage and added to your templates list.`}
          />

          <div className="flex justify-between gap-2 pt-2 border-t border-gray-700">
            <Button intent="primary-outline" onClick={handleCancelImport}>
              Cancel
            </Button>
            <div className="flex gap-2">
              {pendingImportTemplates.length === 1 ? (
                <>
                  <Button
                    intent="gray-outline"
                    onClick={() => handleConfirmImport(false)}
                  >
                    OK
                  </Button>
                  <Button
                    intent="white"
                    rounded
                    onClick={() => handleConfirmImport(true)}
                  >
                    Use This Template Now
                  </Button>
                </>
              ) : (
                <Button
                  intent="white"
                  rounded
                  onClick={() => handleConfirmImport(false)}
                >
                  Confirm Import
                </Button>
              )}
            </div>
          </div>
        </div>
      </Modal>

      {/* Delete Confirmation Dialog */}
      <ConfirmationDialog {...confirmDeleteTemplate} />
    </>
  );
}
