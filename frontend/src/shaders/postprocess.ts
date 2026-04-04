export const NVG_SHADER = /* glsl */ `
  uniform sampler2D colorTexture;
  uniform float noiseAmount;
  uniform float brightness;
  in vec2 v_textureCoordinates;

  float random(vec2 co) {
    return fract(sin(dot(co.xy, vec2(12.9898, 78.233))) * 43758.5453);
  }

  void main() {
    vec4 color = texture(colorTexture, v_textureCoordinates);

    // Convert to luminance
    float lum = dot(color.rgb, vec3(0.299, 0.587, 0.114));

    // Green phosphor tint
    vec3 nvg = vec3(0.1, 1.0, 0.2) * lum * brightness;

    // Film grain noise (use UV-based seed for variation)
    float noise = random(v_textureCoordinates * 800.0) * noiseAmount;
    nvg += noise;

    // Vignette (stronger for NVG tube effect)
    float d = length(v_textureCoordinates - 0.5);
    float vignette = 1.0 - smoothstep(0.2, 0.7, d);
    nvg *= vignette;

    // Slight bloom on bright areas
    float bloom = smoothstep(0.6, 1.0, lum) * 0.3;
    nvg += vec3(0.05, 0.4, 0.1) * bloom;

    out_FragColor = vec4(nvg, 1.0);
  }
`;

export const FLIR_SHADER = /* glsl */ `
  uniform sampler2D colorTexture;
  uniform float contrast;
  uniform float edgeDetection;
  in vec2 v_textureCoordinates;

  void main() {
    vec2 uv = v_textureCoordinates;
    vec4 color = texture(colorTexture, uv);

    // Luminance
    float lum = dot(color.rgb, vec3(0.299, 0.587, 0.114));

    // Contrast enhancement
    lum = clamp((lum - 0.5) * contrast + 0.5, 0.0, 1.0);

    // Edge detection (Sobel-like)
    float texelSize = 1.0 / 1024.0;
    float lumL = dot(texture(colorTexture, uv + vec2(-texelSize, 0.0)).rgb, vec3(0.299, 0.587, 0.114));
    float lumR = dot(texture(colorTexture, uv + vec2(texelSize, 0.0)).rgb, vec3(0.299, 0.587, 0.114));
    float lumT = dot(texture(colorTexture, uv + vec2(0.0, texelSize)).rgb, vec3(0.299, 0.587, 0.114));
    float lumB = dot(texture(colorTexture, uv + vec2(0.0, -texelSize)).rgb, vec3(0.299, 0.587, 0.114));
    float edge = abs(lumL - lumR) + abs(lumT - lumB);

    // White-hot thermal palette (inverted)
    float thermal = 1.0 - lum;
    vec3 thermalColor = vec3(thermal);

    // Add edge highlights
    thermalColor += vec3(edge * edgeDetection);

    // Subtle colour tint for hot spots
    if (thermal < 0.3) {
      thermalColor = mix(thermalColor, vec3(1.0, 0.8, 0.4), (0.3 - thermal) * 2.0);
    }

    out_FragColor = vec4(thermalColor, 1.0);
  }
`;

export const SHADER_DEFAULTS = {
  nvg: {
    noiseAmount: 0.1,
    brightness: 1.5,
  },
  flir: {
    contrast: 1.2,
    edgeDetection: 0.3,
  },
} as const;

export type ShaderMode = 'none' | 'nvg' | 'flir';
