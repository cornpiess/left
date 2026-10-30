Pod::Spec.new do |s|
  s.name = 'MaoqiuPhotoPreview'
  s.version = '1.0.0'
  s.summary = 'Size-aware local PhotoKit previews'
  s.description = 'Cancellable PhotoKit previews for Maoqiu'
  s.license = { :type => 'MIT' }
  s.author = 'Maoqiu'
  s.homepage = 'https://github.com/cornpiess/left'
  s.platforms = { :ios => '16.4' }
  s.source = { :git => 'https://github.com/cornpiess/left.git' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.{h,m,mm,swift}'
  s.swift_version = '5.9'
end
